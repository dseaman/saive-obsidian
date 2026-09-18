// StatePort over the plugin's data.json, plus the per-device auto-sync
// interval. data.json holds `{ settings, sync }` and travels with the vault
// (iCloud, git, Obsidian Sync), so the sync token is never written here:
// it lives in app.secretStorage. The auto-sync interval goes through
// app.saveLocalStorage for the same reason in reverse: it is a property of
// this device, and a phone should not inherit a desktop's choice.

import type { App, Plugin } from 'obsidian';
import type { SyncState } from '../core/plan';
import type { StatePort } from '../core/ports';
import { autoSyncFrom, settingsFrom } from '../settings';
import type { AutoSyncMinutes, SaiveSettings } from '../settings';

export interface PluginData {
	settings: SaiveSettings;
	sync: SyncState | null;
}

const AUTO_SYNC_KEY = 'saive-auto-sync';

function isState(value: unknown): value is SyncState {
	if (typeof value !== 'object' || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.cursor === 'string' && typeof row.files === 'object' && row.files !== null;
}

export async function loadPluginData(plugin: Plugin): Promise<PluginData> {
	const raw: unknown = await plugin.loadData();
	const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		settings: settingsFrom(row.settings),
		sync: isState(row.sync) ? row.sync : null,
	};
}

export async function savePluginData(plugin: Plugin, data: PluginData): Promise<void> {
	await plugin.saveData(data);
}

export class PluginDataState implements StatePort {
	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<SyncState | null> {
		return (await loadPluginData(this.plugin)).sync;
	}

	async save(state: SyncState): Promise<void> {
		const data = await loadPluginData(this.plugin);
		await savePluginData(this.plugin, { ...data, sync: state });
	}
}

/** How often this device syncs on its own, in minutes; 0 means manual only. */
export function readAutoSync(app: App): AutoSyncMinutes {
	return autoSyncFrom(app.loadLocalStorage(AUTO_SYNC_KEY));
}

export function writeAutoSync(app: App, minutes: AutoSyncMinutes): void {
	app.saveLocalStorage(AUTO_SYNC_KEY, minutes);
}

/** Files the last completed sync left tracked, for the settings tab's status line. */
export async function trackedCount(plugin: Plugin): Promise<number> {
	const { sync } = await loadPluginData(plugin);
	return sync === null ? 0 : Object.keys(sync.files).length;
}
