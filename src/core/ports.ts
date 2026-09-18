// The three seams between the pure sync core and Obsidian. The engine
// (engine.ts) and client (client.ts) talk to these interfaces alone; the
// adapters under src/obsidian/ implement them over the Obsidian API, and
// vitest drives the same engine with in-memory fakes.

import type { SyncState } from './plan';

export interface VaultPort {
	/** Every markdown path under `root`, for `occupied` and the uuid index. */
	listMarkdown(root: string): Promise<string[]>;
	/**
	 * The uuid a path's frontmatter carries, or null when the file has no
	 * `uuid` or no `saive_schema`. A note that merely mentions a uuid in its
	 * body must never count.
	 */
	uuidOf(path: string): Promise<string | null>;
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	/**
	 * Create parent folders as needed. When the file exists the adapter
	 * overwrites through `vault.process`, so an editor with the file open
	 * sees the change.
	 */
	write(path: string, markdown: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	trash(path: string): Promise<void>;
	/** Copy for a conflict: read `from`, create `to`. Never overwrites `to`. */
	copy(from: string, to: string): Promise<void>;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface HttpPort {
	/**
	 * GET only. Never throws on a non-2xx status; the client maps the status
	 * to a typed error. Throws on a network failure.
	 */
	get(url: string, headers: Record<string, string>): Promise<HttpResponse>;
}

export interface StatePort {
	load(): Promise<SyncState | null>;
	save(state: SyncState): Promise<void>;
}
