import { Notice, Plugin } from 'obsidian';
import { SyncClient } from './core/client';
import { SyncEngine } from './core/engine';
import type { SyncReport } from './core/engine';
import { ObsidianHttp } from './obsidian/http-adapter';
import { confirmMassTrash } from './obsidian/mass-trash-modal';
import { loadPluginData, PluginDataState, readAutoSync } from './obsidian/state-adapter';
import { ObsidianVault } from './obsidian/vault-adapter';
import { DEFAULT_SETTINGS } from './settings';
import type { SaiveSettings } from './settings';

// Saive for Obsidian: a one-way mirror of a Saive library. Saive's storage is
// the source of truth, so this plugin reads from app.saive.my and never
// writes back. This file wires the pure engine (src/core) to Obsidian
// (src/obsidian) and registers the commands and the interval. The link flow
// and the settings tab arrive in the next release.

const BASE_URL = 'https://app.saive.my';
const TOKEN_SECRET_ID = 'saive-sync-token';
/** Longest wait a 429 can ask for before the plugin leaves it to the next sync. */
const MAX_RETRY_SECONDS = 3600;
/** Automatic 429 retries per load; the interval or the user takes over after. */
const MAX_RETRIES = 3;
/** Quiet-run failures in a row before one notice per load. */
const FAILURES_BEFORE_NOTICE = 3;

interface RunOptions {
	full: boolean;
	/** A user-triggered run reports its outcome; a background run stays quiet. */
	announce: boolean;
}

export default class SaivePlugin extends Plugin {
	settings: SaiveSettings = DEFAULT_SETTINGS;
	private engine: SyncEngine | null = null;
	private warnedUnlinked = false;
	private warnedFailing = false;
	private quietFailures = 0;
	private retries = 0;
	private retryTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = (await loadPluginData(this)).settings;
		this.engine = new SyncEngine({
			client: new SyncClient({
				baseUrl: BASE_URL,
				http: new ObsidianHttp(),
				token: () => Promise.resolve(this.readToken()),
				pluginVersion: this.manifest.version,
			}),
			vault: new ObsidianVault(this.app),
			state: new PluginDataState(this),
			root: this.settings.root,
			log: (message) => console.debug(`[saive] ${message}`),
			confirmMassTrash: (count, tracked) => confirmMassTrash(this.app, count, tracked),
		});

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

		this.app.workspace.onLayoutReady(() => {
			void this.runSync({ full: false, announce: false });
		});

		const minutes = this.settings.intervalMinutes;
		if (minutes > 0 && readAutoSync(this.app)) {
			this.registerInterval(
				window.setInterval(() => {
					void this.runSync({ full: false, announce: false });
				}, minutes * 60 * 1000),
			);
		}
		this.register(() => this.clearRetry());
	}

	// Older apps have no secretStorage; the manifest's minAppVersion keeps
	// them out, and this guard keeps a missing token from becoming a crash.
	private readToken(): string | null {
		const storage: unknown = this.app.secretStorage;
		if (typeof storage !== 'object' || storage === null) return null;
		return this.app.secretStorage.getSecret(TOKEN_SECRET_ID);
	}

	private async runSync(opts: RunOptions): Promise<void> {
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
