// Plugin settings, stored in data.json beside the sync state. The sync
// token is not here and never will be: it lives in app.secretStorage,
// because data.json travels with a vault that many people commit to
// public git. The auto-sync interval is not here either: it is a property
// of one device (a phone on cellular, a desktop on a wire) and goes
// through app.saveLocalStorage; autoSyncFrom parses what comes back.

export interface SaiveSettings {
	/** Vault folder that holds the mirror. */
	root: string;
}

export const DEFAULT_SETTINGS: SaiveSettings = {
	root: 'Saive',
};

/** The root as the engine sees it: no surrounding whitespace or slashes. */
export function cleanRoot(root: string): string {
	return root.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Why a cleaned root is unusable, or null when it is fine. An empty root
 * would spread saves over the whole vault; a `..` segment would point the
 * mirror outside it.
 */
export function rootProblem(root: string): 'empty' | 'escapes' | null {
	if (root === '') return 'empty';
	if (root.split('/').some((segment) => segment === '..')) return 'escapes';
	return null;
}

export function settingsFrom(raw: unknown): SaiveSettings {
	const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	const cleaned = typeof row.root === 'string' ? cleanRoot(row.root) : '';
	const root = rootProblem(cleaned) === null ? cleaned : DEFAULT_SETTINGS.root;
	return { root };
}

/** Auto-sync interval in minutes for this device. 0 means manual only. */
export type AutoSyncMinutes = 0 | 15 | 60;

export const AUTO_SYNC_OPTIONS: readonly AutoSyncMinutes[] = [0, 15, 60];
export const DEFAULT_AUTO_SYNC: AutoSyncMinutes = 15;

export function autoSyncLabel(minutes: AutoSyncMinutes): string {
	switch (minutes) {
		case 0:
			return 'Off';
		case 15:
			return 'Every 15 minutes';
		case 60:
			return 'Every hour';
	}
}

/**
 * The stored per-device value, in any shape an earlier build wrote: a
 * number of minutes, or the boolean on/off flag from before the interval
 * moved here. Anything else is the default.
 */
export function autoSyncFrom(raw: unknown): AutoSyncMinutes {
	if (raw === false) return 0;
	if (raw === true) return DEFAULT_AUTO_SYNC;
	for (const option of AUTO_SYNC_OPTIONS) {
		if (raw === option || raw === String(option)) return option;
	}
	return DEFAULT_AUTO_SYNC;
}
