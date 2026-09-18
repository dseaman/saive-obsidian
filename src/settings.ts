// Plugin settings, stored in data.json beside the sync state. The sync
// token is not here and never will be: it lives in app.secretStorage,
// because data.json travels with a vault that many people commit to
// public git.

export interface SaiveSettings {
	/** Vault folder that holds the mirror. */
	root: string;
	/** Auto-sync interval in minutes. 0 means manual only. */
	intervalMinutes: number;
}

export const DEFAULT_SETTINGS: SaiveSettings = {
	root: 'Saive',
	intervalMinutes: 15,
};

/** The root as the engine sees it: no surrounding whitespace or slashes. */
export function cleanRoot(root: string): string {
	return root.trim().replace(/^\/+|\/+$/g, '');
}

export function settingsFrom(raw: unknown): SaiveSettings {
	const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	// A root of "" or "/" would spread saves over the whole vault.
	const root =
		typeof row.root === 'string' && cleanRoot(row.root) !== '' ? cleanRoot(row.root) : DEFAULT_SETTINGS.root;
	const minutes =
		typeof row.intervalMinutes === 'number' && Number.isFinite(row.intervalMinutes) && row.intervalMinutes >= 0
			? row.intervalMinutes
			: DEFAULT_SETTINGS.intervalMinutes;
	return { root, intervalMinutes: minutes };
}
