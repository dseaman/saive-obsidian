// The settings tab: account, sync, help. Declarative (getSettingDefinitions,
// Obsidian 1.13.0 and later) so every row shows up in Obsidian's settings
// search. Each row is a `render` row, never a `control` row: the folder
// needs validation before it saves, and the auto-sync choice lives per
// device outside plugin.settings, so neither fits the default control store.
// No sync logic here: every button calls back into the plugin.

import { getLanguage, normalizePath, Notice, PluginSettingTab } from 'obsidian';
import type { App, Setting, SettingDefinitionItem } from 'obsidian';
import { DOCS_URL, PRIVACY_URL, SIGNUP_URL } from '../core/link';
import { relativeTime } from '../core/relative-time';
import type SaivePlugin from '../main';
import { AUTO_SYNC_OPTIONS, autoSyncFrom, autoSyncLabel, cleanRoot, rootProblem } from '../settings';

/** How often the "Last sync" line re-renders while the tab is open. */
const STATUS_REFRESH_MS = 30_000;

export class SaiveSettingTab extends PluginSettingTab {
	// The account rows depend on the token store, which answers through a
	// Promise, while visible() predicates are synchronous. The tab caches the
	// answer and re-applies the predicates when it changes.
	private linked = false;
	// The rendered "Last sync" row, so Full resync can refresh it too.
	private status: Setting | null = null;

	constructor(
		app: App,
		private readonly plugin: SaivePlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		void this.refreshLinked();
		return [
			{
				type: 'group',
				heading: 'Account',
				items: [
					{
						name: 'Connected',
						desc: 'This plugin reads your library and never writes to it. To revoke its access, remove this vault from your account settings at app.saive.my.',
						aliases: ['disconnect', 'account'],
						visible: () => this.linked,
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('Disconnect').onClick(() => {
									void this.plugin.disconnectAccount().then(() => this.refreshLinked());
								}),
							);
						},
					},
					{
						name: 'Not connected',
						desc: 'Saive keeps a copy of your library in this vault as Markdown notes.',
						aliases: ['connect', 'account', 'sign up'],
						visible: () => !this.linked,
						render: (setting) => {
							setting
								.addButton((btn) =>
									btn.setButtonText('Create a free account').onClick(() => {
										this.plugin.openUrl(SIGNUP_URL);
									}),
								)
								.addButton((btn) =>
									btn.setButtonText('Connect account').onClick(() => {
										// connectAccount resolves when the link modal closes, so the
										// row can flip to "Connected" while the tab is on screen.
										void this.plugin.connectAccount().then(() => this.refreshLinked());
									}),
								);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Sync',
				items: [
					{
						name: 'Folder',
						desc: 'The vault folder that holds your Saive notes.',
						render: (setting) => {
							setting.addText((text) => {
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
						},
					},
					{
						name: 'Automatic sync on this device',
						desc: 'Each device keeps its own choice.',
						aliases: ['interval', 'schedule'],
						render: (setting) => {
							setting.addDropdown((drop) => {
								for (const option of AUTO_SYNC_OPTIONS) drop.addOption(String(option), autoSyncLabel(option));
								drop.setValue(String(this.plugin.autoSync())).onChange((value) => {
									this.plugin.setAutoSync(autoSyncFrom(value));
								});
							});
						},
					},
					{
						name: 'Last sync',
						desc: 'When this device last synced.',
						aliases: ['sync now'],
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('Sync now').onClick(() => {
									btn.setDisabled(true);
									void this.plugin.runSync({ full: false, announce: true }).finally(() => {
										btn.setDisabled(false);
										this.renderStatus(setting);
									});
								}),
							);
							this.status = setting;
							this.renderStatus(setting);
							return this.startRefresh(setting);
						},
					},
					{
						name: 'Full resync',
						desc: 'Re-checks every note against Saive and restores notes you deleted from this vault.',
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('Full resync').onClick(() => {
									btn.setDisabled(true);
									void this.plugin.runSync({ full: true, announce: true }).finally(() => {
										btn.setDisabled(false);
										if (this.status !== null) this.renderStatus(this.status);
									});
								}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Help',
				items: [
					{
						name: 'How syncing works',
						desc: 'Opens the plugin documentation.',
						aliases: ['docs', 'documentation'],
						action: () => {
							this.plugin.openUrl(DOCS_URL);
						},
					},
					{
						name: 'Privacy',
						desc: 'Opens the Saive privacy policy.',
						action: () => {
							this.plugin.openUrl(PRIVACY_URL);
						},
					},
				],
			},
		];
	}

	private async refreshLinked(): Promise<void> {
		const linked = await this.plugin.isLinked();
		if (linked === this.linked) return;
		this.linked = linked;
		this.refreshDomState();
	}

	private renderStatus(setting: Setting): void {
		const last = this.plugin.lastSync;
		if (last === null) {
			setting.setDesc('Never');
			return;
		}
		const notes = last.tracked === 1 ? '1 note' : `${last.tracked} notes`;
		setting.setDesc(`${relativeTime(last.at, Date.now(), getLanguage())} · ${notes}`);
	}

	// Returns the render cleanup, which clears the timer when the row is torn
	// down. Registered with the plugin too, so unload clears it either way.
	private startRefresh(setting: Setting): () => void {
		const timer = window.setInterval(() => {
			this.renderStatus(setting);
		}, STATUS_REFRESH_MS);
		this.plugin.registerInterval(timer);
		return () => {
			window.clearInterval(timer);
			if (this.status === setting) this.status = null;
		};
	}
}
