// StatePort over the plugin's data.json, plus the per-device auto-sync
// flag. data.json holds `{ settings, sync }` and travels with the vault
// (iCloud, git, Obsidian Sync), so the sync token is never written here:
// it lives in app.secretStorage. The auto-sync flag goes through
// app.saveLocalStorage for the same reason in reverse: it is a property of
// this device, and a phone should not inherit a desktop's choice.

import type { App, Plugin } from 'obsidian';
import type { SyncState } from '../core/plan';
import type { StatePort } from '../core/ports';
import { settingsFrom } from '../settings';
import type { SaiveSettings } from '../settings';

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

/** Whether this device syncs on an interval. Defaults to on. */
export function readAutoSync(app: App): boolean {
	const stored: unknown = app.loadLocalStorage(AUTO_SYNC_KEY);
	return stored === null || stored === undefined ? true : stored === true;
}

export function writeAutoSync(app: App, on: boolean): void {
	app.saveLocalStorage(AUTO_SYNC_KEY, on);
}
