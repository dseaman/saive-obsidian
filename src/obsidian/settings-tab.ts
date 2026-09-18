// The settings tab: account, sync, help. Imperative display() because the
// plugin supports Obsidian 1.11.4, which predates the declarative settings
// API. No sync logic here: every button calls back into the plugin.

import { moment, normalizePath, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { DOCS_URL, PRIVACY_URL, SIGNUP_URL } from '../core/link';
import type SaivePlugin from '../main';
import { AUTO_SYNC_OPTIONS, autoSyncFrom, autoSyncLabel, cleanRoot, rootProblem } from '../settings';

/** How often the "Last sync" line re-renders while the tab is open. */
const STATUS_REFRESH_MS = 30_000;

export class SaiveSettingTab extends PluginSettingTab {
	private refreshTimer: number | null = null;
	private visible = false;

	constructor(
		app: App,
		private readonly plugin: SaivePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.visible = true;
		this.rerender();
	}

	private rerender(): void {
		this.containerEl.empty();
		void this.render();
	}

	hide(): void {
		this.visible = false;
		this.stopRefresh();
		this.containerEl.empty();
	}

	private async render(): Promise<void> {
		const el = this.containerEl;
		const linked = await this.plugin.isLinked();
		// Hidden during the await: hide() emptied the container; leave it so.
		if (!this.visible) return;

		new Setting(el).setName('Account').setHeading();
		if (linked) {
			new Setting(el)
				.setName('Connected')
				.setDesc(
					'This plugin reads your library and never writes to it. To revoke its access, remove this vault from your account settings at app.saive.my.',
				)
				.addButton((btn) =>
					btn.setButtonText('Disconnect').onClick(() => {
						void this.plugin.disconnectAccount().then(() => {
							this.rerender();
						});
					}),
				);
		} else {
			new Setting(el)
				.setName('Not connected')
				.setDesc('Saive keeps a copy of your library in this vault as Markdown notes.')
				.addButton((btn) =>
					btn.setButtonText('Create a free account').onClick(() => {
						this.plugin.openUrl(SIGNUP_URL);
					}),
				)
				.addButton((btn) =>
					btn.setButtonText('Connect account').onClick(() => {
						void this.connect();
					}),
				);
		}

		new Setting(el).setName('Sync').setHeading();
		new Setting(el)
			.setName('Folder')
			.setDesc('The vault folder that holds your Saive notes.')
			.addText((text) => {
				text.setPlaceholder('Saive').setValue(this.plugin.settings.root);
				// Save on Enter or blur, so a half-typed name never reaches the engine.
				text.inputEl.addEventListener('change', () => {
					const root = cleanRoot(normalizePath(text.getValue()));
					const problem = rootProblem(root);
					if (problem !== null) {
						new Notice(problem === 'empty' ? 'Folder cannot be empty.' : 'Folder must stay inside the vault.');
						text.setValue(this.plugin.settings.root);
						return;
					}
					text.setValue(root);
					void this.plugin.setRoot(root);
				});
			});

		new Setting(el)
			.setName('Automatic sync on this device')
			.setDesc('Each device keeps its own choice.')
			.addDropdown((drop) => {
				for (const option of AUTO_SYNC_OPTIONS) drop.addOption(String(option), autoSyncLabel(option));
				drop.setValue(String(this.plugin.autoSync())).onChange((value) => {
					this.plugin.setAutoSync(autoSyncFrom(value));
				});
			});

		const status = new Setting(el).setName('Last sync').addButton((btn) =>
			btn.setButtonText('Sync now').onClick(() => {
				btn.setDisabled(true);
				void this.plugin.runSync({ full: false, announce: true }).finally(() => {
					btn.setDisabled(false);
					this.renderStatus(status);
				});
			}),
		);
		this.renderStatus(status);
		this.startRefresh(status);

		new Setting(el)
			.setName('Full resync')
			.setDesc('Re-checks every note against Saive and restores notes you deleted from this vault.')
			.addButton((btn) =>
				btn.setButtonText('Full resync').onClick(() => {
					btn.setDisabled(true);
					void this.plugin.runSync({ full: true, announce: true }).finally(() => {
						btn.setDisabled(false);
						this.renderStatus(status);
					});
				}),
			);

		new Setting(el).setName('Help').setHeading();
		const help = el.createEl('p', { cls: 'saive-sync-status' });
		help.createEl('a', { text: 'How syncing works', href: DOCS_URL });
		help.appendText(' · ');
		help.createEl('a', { text: 'Privacy', href: PRIVACY_URL });
	}

	// connectAccount resolves when the link modal closes, so the account row
	// can flip to "Connected" while the tab is still on screen.
	private async connect(): Promise<void> {
		await this.plugin.connectAccount();
		if (this.visible) this.rerender();
	}

	private renderStatus(status: Setting): void {
		const last = this.plugin.lastSync;
		if (last === null) {
			status.setDesc('Never');
			return;
		}
		const notes = last.tracked === 1 ? '1 note' : `${last.tracked} notes`;
		status.setDesc(`${moment(last.at).fromNow()} · ${notes}`);
	}

	// Registered with the plugin so unload clears it even if hide() never
	// runs; hide() clears it too, so a closed tab costs nothing.
	private startRefresh(status: Setting): void {
		this.stopRefresh();
		this.refreshTimer = window.setInterval(() => {
			this.renderStatus(status);
		}, STATUS_REFRESH_MS);
		this.plugin.registerInterval(this.refreshTimer);
	}

	private stopRefresh(): void {
		if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}
}
