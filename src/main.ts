import { Notice, Platform, Plugin } from 'obsidian';
import { SyncClient } from './core/client';
import { SyncEngine } from './core/engine';
import type { SyncReport } from './core/engine';
import { BASE_URL, generateSecret, runLinkFlow, startLink } from './core/link';
import { ObsidianHttp } from './obsidian/http-adapter';
import { LinkModal } from './obsidian/link-modal';
import { confirmMassTrash } from './obsidian/mass-trash-modal';
import { SaiveSettingTab } from './obsidian/settings-tab';
import {
	loadPluginData,
	PluginDataState,
	readAutoSync,
	savePluginData,
	trackedCount,
	writeAutoSync,
} from './obsidian/state-adapter';
import { TokenStore } from './obsidian/token-store';
import { ObsidianVault } from './obsidian/vault-adapter';
import { DEFAULT_SETTINGS } from './settings';
import type { AutoSyncMinutes, SaiveSettings } from './settings';

// Saive for Obsidian: a one-way mirror of a Saive library. Saive's storage is
// the source of truth, so this plugin reads from app.saive.my and never
// writes back. This file wires the pure engine (src/core) to Obsidian
// (src/obsidian), runs the link flow, and registers the commands, the
// protocol handler, the settings tab and the interval.

/** Longest wait a 429 can ask for before the plugin leaves it to the next sync. */
const MAX_RETRY_SECONDS = 3600;
/** Automatic 429 retries per load; the interval or the user takes over after. */
const MAX_RETRIES = 3;
/** Quiet-run failures in a row before one notice per load. */
const FAILURES_BEFORE_NOTICE = 3;

export interface RunOptions {
	full: boolean;
	/** A user-triggered run reports its outcome; a background run stays quiet. */
	announce: boolean;
}

export interface LastSync {
	/** Epoch milliseconds when the run finished. */
	at: number;
	/** Files tracked after the run. */
	tracked: number;
}

export default class SaivePlugin extends Plugin {
	settings: SaiveSettings = DEFAULT_SETTINGS;
	tokens: TokenStore = new TokenStore(this.app);
	/** The last completed run this load, for the settings tab. */
	lastSync: LastSync | null = null;
	private client: SyncClient | null = null;
	private engine: SyncEngine | null = null;
	private linkModal: LinkModal | null = null;
	private intervalId: number | null = null;
	private warnedUnlinked = false;
	private warnedFailing = false;
	private quietFailures = 0;
	private retries = 0;
	private retryTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = (await loadPluginData(this)).settings;
		this.client = new SyncClient({
			baseUrl: BASE_URL,
			http: new ObsidianHttp(),
			token: () => this.tokens.get(),
			pluginVersion: this.manifest.version,
		});
		this.engine = this.buildEngine(this.client);

		this.addSettingTab(new SaiveSettingTab(this.app, this));

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => void this.runSync({ full: false, announce: true }),
		});
		this.addCommand({
			id: 'full-resync',
			name: 'Full resync',
			callback: () => void this.runSync({ full: true, announce: true }),
		});
		this.addCommand({
			id: 'connect-account',
			name: 'Connect account',
			callback: () => void this.connectAccount(),
		});

		// The consent page links back here once the user approves. The page
		// cannot hand over anything (the plugin holds the secret; the server
		// holds its hash), so the link only asks the plugin to check again.
		// No nonce: the worst a forged obsidian://saive?linked=1 can do is
		// start a read-only sync the interval would have started anyway.
		this.registerObsidianProtocolHandler('saive', (params) => {
			if (params.linked !== '1' && params.linked !== 'true') return;
			if (this.linkModal !== null) {
				this.linkModal.pollNow();
				return;
			}
			void this.runSync({ full: false, announce: true });
		});

		this.app.workspace.onLayoutReady(() => {
			void this.runSync({ full: false, announce: false });
		});

		this.applyAutoSync();
		this.register(() => this.clearRetry());
		this.register(() => this.linkModal?.close());
	}

	private buildEngine(client: SyncClient): SyncEngine {
		return new SyncEngine({
			client,
			vault: new ObsidianVault(this.app),
			state: new PluginDataState(this),
			root: this.settings.root,
			log: (message) => console.debug(`[saive] ${message}`),
			confirmMassTrash: (count, tracked) => confirmMassTrash(this.app, count, tracked),
		});
	}

	isLinked(): Promise<boolean> {
		return this.tokens.get().then((token) => token !== null);
	}

	openUrl(url: string): void {
		window.open(url);
	}

	/**
	 * Generate a candidate secret, open the consent page and show the check
	 * code. The candidate stays in memory until the server accepts it
	 * (runLinkFlow stores it on 'linked' and never otherwise), so a linked
	 * user who starts a second link and walks away keeps the working secret.
	 * Resolves when the modal closes: linked, cancelled or timed out.
	 */
	async connectAccount(): Promise<void> {
		if (!this.tokens.available()) {
			new Notice('Saive needs Obsidian 1.11.4 or later.');
			return;
		}
		this.linkModal?.close();
		const secret = generateSecret((n) => crypto.getRandomValues(new Uint8Array(n)));
		const { code, url } = await startLink({
			secret,
			vaultName: this.app.vault.getName(),
			baseUrl: BASE_URL,
		});
		// A client for the poll alone: its token is the candidate, not the
		// secret in storage.
		const candidate = new SyncClient({
			baseUrl: BASE_URL,
			http: new ObsidianHttp(),
			token: () => Promise.resolve(secret),
			pluginVersion: this.manifest.version,
		});
		// Mobile WebViews drop a window.open that follows an await; the modal
		// carries a real link for the tap. Desktop opens the page at once.
		const autoOpened = !Platform.isMobile;
		if (autoOpened) this.openUrl(url);
		await new Promise<void>((resolve) => {
			const modal = new LinkModal(this.app, {
				code,
				url,
				autoOpened,
				run: (poll) => runLinkFlow({ secret, client: candidate, store: this.tokens, poll }),
				onLinked: () => {
					this.warnedUnlinked = false;
					void this.runSync({ full: false, announce: true });
				},
				onClosed: () => {
					if (this.linkModal === modal) this.linkModal = null;
					resolve();
				},
			});
			this.linkModal = modal;
			modal.open();
		});
	}

	/**
	 * Forget the secret on this device. The token row on the server stays
	 * until the user removes it under Settings on the web, or it idles out:
	 * a read-only client cannot revoke itself.
	 */
	async disconnectAccount(): Promise<void> {
		this.linkModal?.close();
		await this.tokens.clear();
		// The user knows this device is unlinked; no notice for it this load.
		this.warnedUnlinked = true;
		new Notice('Disconnected. Remove this vault from your account settings at app.saive.my to revoke it.');
	}

	async setRoot(root: string): Promise<void> {
		if (root === this.settings.root || this.client === null) return;
		this.settings = { ...this.settings, root };
		const data = await loadPluginData(this);
		await savePluginData(this, { ...data, settings: this.settings });
		// The engine takes its root once; a new root means a new engine.
		this.engine = this.buildEngine(this.client);
	}

	autoSync(): AutoSyncMinutes {
		return readAutoSync(this.app);
	}

	setAutoSync(minutes: AutoSyncMinutes): void {
		writeAutoSync(this.app, minutes);
		this.applyAutoSync();
	}

	// One interval at a time, registered so unload clears it. Called again
	// whenever the per-device choice changes.
	private applyAutoSync(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const minutes = readAutoSync(this.app);
		if (minutes === 0) return;
		this.intervalId = window.setInterval(
			() => {
				void this.runSync({ full: false, announce: false });
			},
			minutes * 60 * 1000,
		);
		this.registerInterval(this.intervalId);
	}

	async runSync(opts: RunOptions): Promise<void> {
		if (this.engine === null) return;
		let report: SyncReport;
		try {
			report = await this.engine.sync({ full: opts.full });
		} catch (err) {
			console.error('[saive] sync failed', err);
			this.failed(opts);
			return;
		}
		this.quietFailures = 0;
		if (report.aborted === undefined) {
			this.lastSync = { at: Date.now(), tracked: await trackedCount(this) };
		}
		this.announce(report, opts);
	}

	// A user-triggered failure gets a notice every time. A background one
	// (offline, say) gets one notice per load after three in a row, so an
	// unreachable server is neither a toast every interval nor a silence.
	private failed(opts: RunOptions): void {
		if (opts.announce) {
			new Notice('Saive sync failed. See the developer console for details.');
			return;
		}
		this.quietFailures += 1;
		if (this.quietFailures >= FAILURES_BEFORE_NOTICE && !this.warnedFailing) {
			this.warnedFailing = true;
			new Notice(
				`Saive sync has failed ${this.quietFailures} times. Open the developer console for details.`,
			);
		}
	}

	private announce(report: SyncReport, opts: RunOptions): void {
		switch (report.aborted) {
			case 'unlinked':
				// Once per load in the background, so an unlinked vault is not
				// nagged every interval; every time when the user asked.
				if (opts.announce || !this.warnedUnlinked) {
					this.warnedUnlinked = true;
					new Notice('Saive is not connected on this device. Connect it in the plugin settings.');
				}
				return;
			case 'rate-limited': {
				const seconds = Math.min(report.retryAfterSeconds ?? 5, MAX_RETRY_SECONDS);
				const scheduled = this.scheduleRetry(seconds);
				if (opts.announce) {
					new Notice(
						scheduled
							? `Saive asked the plugin to wait ${seconds} seconds. Sync will resume on its own.`
							: `Saive asked the plugin to wait ${seconds} seconds. Run "Sync now" again later.`,
					);
				}
				return;
			}
			case 'mass-trash':
				new Notice('Saive sync paused. Nothing was trashed.');
				return;
			case undefined:
				this.retries = 0;
				if (opts.announce) {
					new Notice(
						`Saive sync done: ${report.written} written, ${report.renamed} moved, ${report.trashed} trashed, ${report.conflicts} conflicts.`,
					);
				}
				return;
		}
	}

	// One pending retry at a time, at most MAX_RETRIES per load without a
	// completed sync in between. The timer id is held here so unload clears
	// it (see onload) and a second 429 replaces it instead of stacking.
	private scheduleRetry(seconds: number): boolean {
		if (this.retries >= MAX_RETRIES) return false;
		this.retries += 1;
		this.clearRetry();
		this.retryTimer = window.setTimeout(
			() => {
				this.retryTimer = null;
				void this.runSync({ full: false, announce: false });
			},
			(seconds + 1) * 1000,
		);
		return true;
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}
