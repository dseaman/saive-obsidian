// The sync engine: pulls pages from the client, asks planPage what to do,
// runs the actions through the VaultPort, and persists state after every
// page so a crash or an app switch on mobile resumes from the last page
// that finished. Reconcile (a manifest diff) repairs what the change feed
// can miss; the mass-trash guard keeps a bad day on the server from
// emptying the user's folder.
//
// Nothing here imports Obsidian. src/obsidian/ supplies the ports and
// engine.test.ts drives the same code with in-memory fakes.

import { MAX_UUIDS_PER_PULL, RateLimitedError, ServerError, UnlinkedError } from './client';
import type { SyncClient } from './client';
import { compareSeq } from './contract';
import type { PullResponse } from './contract';
import { frontmatterField } from './frontmatter';
import { bodyHash, fullHash } from './hash';
import { planPage } from './plan';
import type { Action, LocalIndex, PlanOptions, SyncState } from './plan';
import type { StatePort, VaultPort } from './ports';

export type AbortReason = 'mass-trash' | 'unlinked' | 'rate-limited';

export interface SyncReport {
	pages: number;
	written: number;
	renamed: number;
	trashed: number;
	conflicts: number;
	skipped: number;
	fetched: number;
	reconciled: boolean;
	aborted?: AbortReason;
	/** Set with `aborted: 'rate-limited'`; the caller reschedules after this. */
	retryAfterSeconds?: number;
}

export interface SyncOptions {
	/** "Full resync": forget user deletions and reconcile against the manifest. */
	full?: boolean;
}

export interface SyncEngineOptions {
	client: Pick<SyncClient, 'pull' | 'file' | 'manifest'>;
	vault: VaultPort;
	state: StatePort;
	/** Vault folder that holds the mirror, e.g. "Saive". */
	root: string;
	log?: (message: string) => void;
	/**
	 * Called before a page that would trash more files than the guard allows.
	 * Resolve true to go ahead, false to leave the page unapplied.
	 */
	confirmMassTrash: (count: number, tracked: number) => Promise<boolean>;
}

/** Server-time gap after which a sync reconciles. Tombstones prune at 30 days. */
export const RECONCILE_AFTER_MS = 25 * 24 * 60 * 60 * 1000;

/** The mass-trash guard fires above max(MASS_TRASH_FLOOR, 10% of tracked files). */
export const MASS_TRASH_FLOOR = 20;
export const MASS_TRASH_FRACTION = 0.1;

export function massTrashLimit(tracked: number): number {
	return Math.max(MASS_TRASH_FLOOR, Math.ceil(MASS_TRASH_FRACTION * tracked));
}

export function emptyState(): SyncState {
	return { cursor: '0', lastReconcileServerTime: null, files: {}, ignored: {} };
}

// Thrown inside a run to unwind to sync() with a report instead of an error.
class Abort extends Error {
	readonly reason: AbortReason;

	constructor(reason: AbortReason) {
		super(`Sync aborted: ${reason}`);
		this.name = 'Abort';
		this.reason = reason;
	}
}

interface Run {
	state: SyncState;
	report: SyncReport;
	/** Every markdown path under root, kept current as actions run. */
	occupied: Set<string>;
	/** uuid to the paths under root whose frontmatter carries it. */
	index: Map<string, Set<string>>;
	reconciled: boolean;
}

function uuidsOn(page: PullResponse): string[] {
	const seen = new Set<string>();
	for (const group of [page.files, page.deleted, page.missing, page.oversize]) {
		for (const item of group) seen.add(item.uuid);
	}
	return [...seen];
}

function withCursor(state: SyncState, cursor: string): SyncState {
	return state.cursor === cursor ? state : { ...state, cursor };
}

export class SyncEngine {
	private readonly client: SyncEngineOptions['client'];
	private readonly vault: VaultPort;
	private readonly store: StatePort;
	private readonly root: string;
	private readonly conflictsDir: string;
	private readonly log: (message: string) => void;
	private readonly confirmMassTrash: SyncEngineOptions['confirmMassTrash'];
	private running: Promise<SyncReport> | null = null;

	constructor(opts: SyncEngineOptions) {
		this.client = opts.client;
		this.vault = opts.vault;
		this.store = opts.state;
		this.root = opts.root.replace(/^\/+|\/+$/g, '');
		this.conflictsDir = `${this.root}/_conflicts`;
		this.log = opts.log ?? (() => {});
		this.confirmMassTrash = opts.confirmMassTrash;
	}

	/** Runs one sync. A call while one runs returns that run's promise. */
	sync(opts: SyncOptions = {}): Promise<SyncReport> {
		if (this.running !== null) return this.running;
		this.running = this.run(opts).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async run(opts: SyncOptions): Promise<SyncReport> {
		const report: SyncReport = {
			pages: 0,
			written: 0,
			renamed: 0,
			trashed: 0,
			conflicts: 0,
			skipped: 0,
			fetched: 0,
			reconciled: false,
		};
		const loaded = await this.store.load();
		// A state written before tombstones existed has no `ignored` field.
		const run: Run = {
			state:
				loaded === null
					? emptyState()
					: { ...loaded, ignored: (loaded as Partial<SyncState>).ignored ?? {} },
			report,
			occupied: new Set(),
			index: new Map(),
			reconciled: false,
		};
		await this.scanVault(run);

		try {
			if (opts.full === true) {
				run.state = { ...run.state, ignored: {} };
				await this.reconcile(run);
			}
			for (;;) {
				const page = await this.client.pull({ since: run.state.cursor });
				if (!run.reconciled && this.needsReconcile(run.state, page)) {
					// Reconcile moves the cursor to the manifest's; the page just
					// pulled is covered by the manifest diff, so pull again.
					await this.reconcile(run);
					continue;
				}
				await this.applyPage(run, page, true);
				if (!page.hasMore) break;
			}
		} catch (err) {
			if (err instanceof Abort) {
				report.aborted = err.reason;
				return report;
			}
			if (err instanceof UnlinkedError) {
				report.aborted = 'unlinked';
				return report;
			}
			if (err instanceof RateLimitedError) {
				report.aborted = 'rate-limited';
				report.retryAfterSeconds = err.retryAfterSeconds;
				return report;
			}
			throw err;
		}
		return report;
	}

	private needsReconcile(state: SyncState, page: PullResponse): boolean {
		if (page.reset) return true;
		// A pull from cursor 0 is a complete snapshot, so a fresh state needs
		// no reconcile: applyPage stamps the first page's serverTime. A state
		// with a cursor and no stamp predates the stamp; reconcile once.
		if (state.lastReconcileServerTime === null) return state.cursor !== '0';
		return Date.parse(page.serverTime) - Date.parse(state.lastReconcileServerTime) > RECONCILE_AFTER_MS;
	}

	// Conflict copies carry the uuid of the save they were copied from. They
	// stay out of the uuid index so the plugin never overwrites, renames or
	// trashes one, but they stay in `occupied` so no new file lands on one.
	private async scanVault(run: Run): Promise<void> {
		const conflictsPrefix = `${this.conflictsDir}/`;
		for (const path of await this.vault.listMarkdown(this.root)) {
			run.occupied.add(path);
			if (path.startsWith(conflictsPrefix)) continue;
			const uuid = await this.vault.uuidOf(path);
			if (uuid !== null) this.indexAdd(run, uuid, path);
		}
	}

	private indexAdd(run: Run, uuid: string, path: string): void {
		let paths = run.index.get(uuid);
		if (paths === undefined) {
			paths = new Set();
			run.index.set(uuid, paths);
		}
		paths.add(path);
	}

	private indexRemove(run: Run, path: string): void {
		for (const paths of run.index.values()) paths.delete(path);
	}

	// What is on disk for these uuids: the indexed paths, plus the recorded
	// path when it sits outside root (the root setting changed) and still
	// carries the uuid. Hashes are read fresh each page: an earlier page may
	// have written the file.
	private async localIndexFor(run: Run, uuids: string[]): Promise<LocalIndex> {
		const local: LocalIndex = {};
		for (const uuid of uuids) {
			const paths = new Set(run.index.get(uuid) ?? []);
			const recorded = run.state.files[uuid]?.path;
			if (
				recorded !== undefined &&
				!paths.has(recorded) &&
				(await this.vault.exists(recorded)) &&
				(await this.vault.uuidOf(recorded)) === uuid
			) {
				paths.add(recorded);
			}
			if (paths.size === 0) continue;
			local[uuid] = [];
			for (const path of paths) {
				const markdown = await this.vault.read(path);
				local[uuid].push({
					path,
					fullHash: await fullHash(markdown),
					bodyHash: await bodyHash(markdown),
				});
			}
		}
		return local;
	}

	private planOptions(run: Run): PlanOptions {
		return { root: this.root, conflictsDir: this.conflictsDir, occupied: run.occupied };
	}

	/**
	 * Plan one page, guard it, run it, persist the state. With `advance`
	 * false (reconcile pages) the cursor stays where it was: reconcile sets
	 * it once at the end, so a crash halfway repeats the reconcile.
	 */
	private async applyPage(run: Run, page: PullResponse, advance: boolean): Promise<void> {
		const before = run.state;
		const local = await this.localIndexFor(run, uuidsOn(page));
		const plan = await planPage(before, page, local, this.planOptions(run));

		const trashes = plan.actions.filter((a) => a.kind === 'trash').length;
		const tracked = Object.keys(before.files).length;
		if (trashes > massTrashLimit(tracked)) {
			this.log(`Sync wants to trash ${trashes} of ${tracked} tracked files; asking first`);
			if (!(await this.confirmMassTrash(trashes, tracked))) throw new Abort('mass-trash');
		}

		let next = plan.state;
		for (const action of plan.actions) {
			if (action.kind === 'fetch') {
				next = await this.fetchAndApply(run, page, action, next, local);
			} else {
				await this.execute(run, action);
			}
		}

		if (!advance) next = withCursor(next, before.cursor);
		if (advance && before.lastReconcileServerTime === null && before.cursor === '0') {
			next = { ...next, lastReconcileServerTime: page.serverTime };
		}
		run.state = next;
		run.report.pages += 1;
		await this.store.save(next);
	}

	// An oversize save arrives as bare markdown. Its folder and title come
	// from the oversize entry when the server sends them, else from what the
	// plugin recorded (folder) and the frontmatter (title). Planned as a
	// one-file page against the state as it stands after the page's other
	// actions, so its path avoids everything the page already placed.
	private async fetchAndApply(
		run: Run,
		page: PullResponse,
		action: Extract<Action, { kind: 'fetch' }>,
		state: SyncState,
		local: LocalIndex,
	): Promise<SyncState> {
		const { uuid, seq } = action;
		let markdown: string;
		try {
			markdown = await this.client.file(uuid);
		} catch (err) {
			// Gone between the pull and the fetch; its delete is on a later page.
			if (err instanceof ServerError && err.status === 404) {
				this.log(`Skipped ${uuid}: the file route returned 404`);
				run.report.skipped += 1;
				return state;
			}
			throw err;
		}
		run.report.fetched += 1;
		const entry = page.oversize.find((o) => o.uuid === uuid);
		const folder =
			entry?.folder !== undefined ? entry.folder : (state.files[uuid]?.remoteFolder ?? null);
		const title = entry?.title ?? frontmatterField(markdown, 'title') ?? uuid;
		const synthetic: PullResponse = {
			files: [{ uuid, seq, folder, title, markdown }],
			deleted: [],
			missing: [],
			oversize: [],
			nextCursor: page.nextCursor,
			hasMore: false,
			reset: false,
			serverTime: page.serverTime,
		};
		const sub = await planPage(state, synthetic, local, this.planOptions(run));
		for (const a of sub.actions) {
			// A one-file page with no oversize entry never plans a fetch.
			if (a.kind !== 'fetch') await this.execute(run, a);
		}
		return sub.state;
	}

	private async execute(run: Run, action: Exclude<Action, { kind: 'fetch' }>): Promise<void> {
		switch (action.kind) {
			case 'write':
				await this.vault.write(action.path, action.markdown);
				run.occupied.add(action.path);
				this.indexAdd(run, action.uuid, action.path);
				run.report.written += 1;
				return;
			case 'conflict':
				await this.vault.copy(action.path, action.copyPath);
				run.occupied.add(action.copyPath);
				run.report.conflicts += 1;
				return;
			case 'rename':
				await this.vault.rename(action.from, action.to);
				run.occupied.delete(action.from);
				run.occupied.add(action.to);
				this.indexRemove(run, action.from);
				this.indexAdd(run, action.uuid, action.to);
				run.report.renamed += 1;
				return;
			case 'trash':
				await this.vault.trash(action.path);
				run.occupied.delete(action.path);
				this.indexRemove(run, action.path);
				run.report.trashed += 1;
				return;
			case 'skip':
				if (action.reason !== 'unchanged') this.log(`Skipped ${action.uuid}: ${action.reason}`);
				run.report.skipped += 1;
				return;
		}
	}

	/**
	 * Diff the manifest against state. Saves the manifest lacks are deletes
	 * (through the planner, so the mass-trash guard and the body-edit rule
	 * apply). Saves it lists at a seq the state lacks or trails are pulled
	 * by uuid, 25 at a time. The cursor and the reconcile stamp move last.
	 */
	private async reconcile(run: Run): Promise<void> {
		const manifest = await this.client.manifest();
		const remote = new Map(manifest.saves);

		const deleted: { uuid: string; seq: string }[] = [];
		for (const [uuid, file] of Object.entries(run.state.files)) {
			if (!remote.has(uuid)) deleted.push({ uuid, seq: file.seq });
		}
		// A tombstone for a save the server has also dropped can go.
		for (const [uuid, seq] of Object.entries(run.state.ignored)) {
			if (!remote.has(uuid)) deleted.push({ uuid, seq });
		}
		if (deleted.length > 0) {
			await this.applyPage(
				run,
				{
					files: [],
					deleted,
					missing: [],
					oversize: [],
					nextCursor: run.state.cursor,
					hasMore: false,
					reset: false,
					serverTime: manifest.serverTime,
				},
				false,
			);
		}

		const stale: string[] = [];
		for (const [uuid, seq] of manifest.saves) {
			const known = run.state.files[uuid]?.seq ?? run.state.ignored[uuid];
			if (known === undefined || compareSeq(seq, known) > 0) stale.push(uuid);
		}
		for (let i = 0; i < stale.length; i += MAX_UUIDS_PER_PULL) {
			const page = await this.client.pull({
				since: '0',
				uuids: stale.slice(i, i + MAX_UUIDS_PER_PULL),
			});
			await this.applyPage(run, page, false);
		}

		run.state = {
			...run.state,
			cursor: manifest.cursor,
			lastReconcileServerTime: manifest.serverTime,
		};
		await this.store.save(run.state);
		run.reconciled = true;
		run.report.reconciled = true;
	}
}
