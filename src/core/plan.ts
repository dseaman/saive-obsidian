// The sync planner. planPage looks at one page of remote changes, the state
// the plugin recorded after its last page, and what the adapter found on
// disk for the uuids on this page, and returns the actions to run plus the
// state to record once they ran. It touches no file and imports nothing from
// Obsidian; the adapter (vault.create, vault.process, fileManager.renameFile,
// fileManager.trashFile) executes the actions in order.
//
// The rules, each pinned by plan.test.ts:
//   - Entries apply in seq order. A uuid seen more than once on a page
//     resolves to its highest-seq entry, so delete-then-recreate keeps the
//     file and recreate-then-delete trashes it.
//   - Equal bytes on disk mean no write. Two hashes decide the rest: fullHash
//     says "write", bodyHash says "conflict". A frontmatter-only local edit
//     is overwritten in place, because Obsidian's property editor rewrites
//     frontmatter on its own. A body edit gets a copy in the conflicts
//     folder before the overwrite.
//   - The user owns placement. A file the user moved or renamed stays where
//     it is; the plugin renames for a remote title or folder change only
//     while the file sits at the path the plugin last recorded.
//   - A file the user deleted stays deleted: the update is skipped and the
//     uuid leaves the state. Full resync is the way back.
//   - A remote delete trashes a file whose body the user left alone and
//     keeps one the user edited. The plugin never trashes a file it did not
//     record.
//   - missing rows are skipped; oversize rows ask the adapter to fetch the
//     file and plan it again as a one-file page.
//   - The cursor advances to nextCursor. Inputs are never mutated.

import { compareSeq } from './contract';
import type { PullFile, PullResponse } from './contract';
import { buildPath, pathMatches, withSuffix } from './filename';
import { bodyHash, fullHash } from './hash';

export interface FileState {
	path: string;
	fullHash: string;
	bodyHash: string;
	remoteFolder: string | null;
	seq: string;
}

export interface SyncState {
	cursor: string;
	lastReconcileServerTime: string | null;
	files: Record<string, FileState>;
}

export interface LocalFile {
	path: string;
	fullHash: string;
	bodyHash: string;
}

/**
 * What the adapter found on disk for the uuids this page touches. A uuid
 * maps to every path that carries it (duplicates happen when a user copies
 * a note). Absent, or an empty list, means no file.
 */
export type LocalIndex = Record<string, LocalFile[]>;

export type Action =
	/** Create or overwrite in place. `markdown` is the server bytes untouched. */
	| { kind: 'write'; uuid: string; path: string; markdown: string }
	/** Copy the local file at `path` to `copyPath` before the write that follows. */
	| { kind: 'conflict'; uuid: string; path: string; copyPath: string }
	| { kind: 'rename'; uuid: string; from: string; to: string }
	| { kind: 'trash'; uuid: string; path: string }
	/** Oversize: fetch /api/sync/file/[uuid], then plan it as a one-file page. */
	| { kind: 'fetch'; uuid: string; seq: string }
	| {
			kind: 'skip';
			uuid: string;
			reason: 'unchanged' | 'user-deleted' | 'missing-remote' | 'body-edited-delete';
	  };

export interface PlanOptions {
	/** Vault folder that holds the mirror, e.g. "Saive". */
	root: string;
	/** Where conflict copies go. Defaults to `<root>/_conflicts`. */
	conflictsDir?: string;
	/**
	 * Paths in use that neither the state nor the local index names, such as
	 * notes under root without a Saive uuid or earlier conflict copies. The
	 * planner never writes to one of these.
	 */
	occupied?: Iterable<string>;
}

export interface Plan {
	actions: Action[];
	state: SyncState;
}

type Entry =
	| { kind: 'file'; uuid: string; seq: string; file: PullFile }
	| { kind: 'delete'; uuid: string; seq: string }
	| { kind: 'missing'; uuid: string; seq: string }
	| { kind: 'oversize'; uuid: string; seq: string };

function orderedEntries(page: PullResponse): Entry[] {
	const all: Entry[] = [
		...page.files.map((file): Entry => ({ kind: 'file', uuid: file.uuid, seq: file.seq, file })),
		...page.deleted.map((d): Entry => ({ kind: 'delete', uuid: d.uuid, seq: d.seq })),
		...page.missing.map((m): Entry => ({ kind: 'missing', uuid: m.uuid, seq: m.seq })),
		...page.oversize.map((o): Entry => ({ kind: 'oversize', uuid: o.uuid, seq: o.seq })),
	];
	all.sort((a, b) => compareSeq(a.seq, b.seq));
	// Ascending order, so the last entry stored per uuid is its highest seq.
	const latest = new Map<string, Entry>();
	for (const entry of all) latest.set(entry.uuid, entry);
	return [...latest.values()].sort((a, b) => compareSeq(a.seq, b.seq));
}

// The recorded path wins when a file still sits there; otherwise the
// smallest path, so duplicates resolve the same way on every run.
function resolveLocal(
	uuid: string,
	recorded: string | undefined,
	local: LocalIndex,
): LocalFile | undefined {
	const candidates = local[uuid];
	if (candidates === undefined || candidates.length === 0) return undefined;
	if (recorded !== undefined) {
		const atRecorded = candidates.find((c) => c.path === recorded);
		if (atRecorded !== undefined) return atRecorded;
	}
	return [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, '');
}

function conflictCopyPath(
	filePath: string,
	uuid: string,
	date: string,
	conflictsDir: string,
	taken: ReadonlySet<string>,
): string {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1);
	const stem = name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
	return buildPath(conflictsDir, null, withSuffix(stem, ` (conflict ${date})`), uuid, taken);
}

export async function planPage(
	state: SyncState,
	page: PullResponse,
	local: LocalIndex,
	opts: PlanOptions,
): Promise<Plan> {
	const files: Record<string, FileState> = { ...state.files };
	const actions: Action[] = [];
	const conflictsDir = opts.conflictsDir ?? `${trimSlashes(opts.root)}/_conflicts`;
	// The UTC date of the ISO serverTime names conflict copies: no local clock.
	const date = page.serverTime.slice(0, 10);

	// Every path a new file must avoid. Maintained as the plan proceeds so
	// two actions on one page never target the same path.
	const taken = new Set<string>();
	for (const f of Object.values(state.files)) taken.add(f.path);
	for (const list of Object.values(local)) for (const f of list) taken.add(f.path);
	for (const p of opts.occupied ?? []) taken.add(p);

	for (const entry of orderedEntries(page)) {
		const { uuid } = entry;
		const existing = files[uuid];

		if (entry.kind === 'missing') {
			actions.push({ kind: 'skip', uuid, reason: 'missing-remote' });
			continue;
		}

		if (entry.kind === 'oversize') {
			actions.push({ kind: 'fetch', uuid, seq: entry.seq });
			continue;
		}

		if (entry.kind === 'delete') {
			if (existing === undefined) continue;
			delete files[uuid];
			const found = resolveLocal(uuid, existing.path, local);
			if (found === undefined) continue;
			if (found.bodyHash === existing.bodyHash) {
				actions.push({ kind: 'trash', uuid, path: found.path });
				taken.delete(found.path);
			} else {
				actions.push({ kind: 'skip', uuid, reason: 'body-edited-delete' });
			}
			continue;
		}

		const { folder, title, markdown } = entry.file;
		const incomingFull = await fullHash(markdown);
		const incomingBody = await bodyHash(markdown);
		const found = resolveLocal(uuid, existing?.path, local);

		if (found === undefined) {
			if (existing !== undefined) {
				actions.push({ kind: 'skip', uuid, reason: 'user-deleted' });
				delete files[uuid];
				continue;
			}
			const path = buildPath(opts.root, folder, title, uuid, taken);
			actions.push({ kind: 'write', uuid, path, markdown });
			taken.add(path);
			files[uuid] = {
				path,
				fullHash: incomingFull,
				bodyHash: incomingBody,
				remoteFolder: folder,
				seq: entry.seq,
			};
			continue;
		}

		let path = found.path;
		let renamed = false;
		const atRecordedPath = existing !== undefined && found.path === existing.path;
		if (atRecordedPath && !pathMatches(found.path, opts.root, folder, title, uuid)) {
			taken.delete(found.path);
			path = buildPath(opts.root, folder, title, uuid, taken);
			taken.add(path);
			actions.push({ kind: 'rename', uuid, from: found.path, to: path });
			renamed = true;
		}

		if (found.fullHash !== incomingFull) {
			// A conflict needs a local body that differs from the incoming one
			// and from what the plugin last wrote. With no record, the file's
			// own body is the only baseline there is.
			const bodyEdited = existing === undefined || found.bodyHash !== existing.bodyHash;
			if (bodyEdited && found.bodyHash !== incomingBody) {
				const copyPath = conflictCopyPath(path, uuid, date, conflictsDir, taken);
				taken.add(copyPath);
				actions.push({ kind: 'conflict', uuid, path, copyPath });
			}
			actions.push({ kind: 'write', uuid, path, markdown });
		} else if (!renamed) {
			actions.push({ kind: 'skip', uuid, reason: 'unchanged' });
		}

		files[uuid] = {
			path,
			fullHash: incomingFull,
			bodyHash: incomingBody,
			remoteFolder: folder,
			seq: entry.seq,
		};
	}

	return {
		actions,
		state: {
			cursor: page.nextCursor,
			lastReconcileServerTime: state.lastReconcileServerTime,
			files,
		},
	};
}
