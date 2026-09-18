import { describe, expect, it } from 'vitest';
import { ServerError, SyncClient } from './client';
import type { ManifestResponse, PullFile, PullResponse } from './contract';
import { emptyState, massTrashLimit, SyncEngine } from './engine';
import type { SyncEngineOptions } from './engine';
import { frontmatterField } from './frontmatter';
import { bodyHash, fullHash } from './hash';
import type { SyncState } from './plan';
import type { HttpPort, HttpResponse, StatePort, VaultPort } from './ports';

// The engine is driven here exactly as main.ts drives it: a real SyncClient
// over a fake HttpPort, a fake vault that remembers every write, rename,
// trash and copy, and a fake state store that records every save. The
// fakes replace Obsidian alone; the rules under test are the engine's.

const ROOT = 'Saive';
const T0 = '2026-09-17T19:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const after = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();

function uuidN(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function md(uuid: string, title: string, body = 'Body.'): string {
	return `---\ntitle: ${title}\nuuid: ${uuid}\nsaive_schema: 1\n---\n\n${body}\n`;
}

function file(n: number, over: Partial<PullFile> = {}): PullFile {
	const uuid = uuidN(n);
	return {
		uuid,
		seq: String(n),
		folder: null,
		title: `Save ${n}`,
		markdown: md(uuid, `Save ${n}`),
		...over,
	};
}

function page(over: Partial<PullResponse> = {}): PullResponse {
	return {
		files: [],
		deleted: [],
		missing: [],
		oversize: [],
		nextCursor: '0',
		hasMore: false,
		reset: false,
		serverTime: T0,
		...over,
	};
}

// A tiny app.saive.my: a change feed keyed by `since`, the current saves
// for the manifest and for `?uuids=` pulls, and raw files for the file
// route. `fail` forces one status on the next request.
class FakeServer implements HttpPort {
	calls: string[] = [];
	feed = new Map<string, PullResponse>();
	saves = new Map<string, PullFile>();
	files = new Map<string, string>();
	manifestCursor = '0';
	manifestTime = T0;
	/** Answer every request past the first `afterCalls` (default 0) with this status. */
	fail: { status: number; headers?: Record<string, string>; afterCalls?: number } | null = null;

	get(url: string, headers: Record<string, string>): Promise<HttpResponse> {
		this.calls.push(url);
		expect(headers.Authorization).toBe('Bearer sv_obs_test');
		if (this.fail !== null && this.calls.length > (this.fail.afterCalls ?? 0)) {
			return Promise.resolve({ status: this.fail.status, headers: this.fail.headers ?? {}, text: '' });
		}
		const u = new URL(url);
		if (u.pathname === '/api/sync/manifest') return this.json(this.manifest());
		if (u.pathname === '/api/sync/pull') {
			const uuids = u.searchParams.get('uuids');
			if (uuids !== null) return this.json(this.byUuid(uuids.split(',')));
			const since = u.searchParams.get('since') ?? '';
			const found = this.feed.get(since);
			if (found === undefined) throw new Error(`test feed has no page for since=${since}`);
			return this.json(found);
		}
		if (u.pathname.startsWith('/api/sync/file/')) {
			const markdown = this.files.get(u.pathname.slice('/api/sync/file/'.length));
			if (markdown === undefined) return Promise.resolve({ status: 404, headers: {}, text: '' });
			return Promise.resolve({ status: 200, headers: {}, text: markdown });
		}
		throw new Error(`unexpected url ${url}`);
	}

	pulls(): string[] {
		return this.calls.filter((c) => c.includes('/api/sync/pull'));
	}

	private manifest(): ManifestResponse {
		return {
			saves: [...this.saves.values()].map((s) => [s.uuid, s.seq]),
			cursor: this.manifestCursor,
			serverTime: this.manifestTime,
		};
	}

	private byUuid(uuids: string[]): PullResponse {
		const files: PullFile[] = [];
		const deleted: { uuid: string; seq: string }[] = [];
		for (const uuid of uuids) {
			const save = this.saves.get(uuid);
			if (save === undefined) deleted.push({ uuid, seq: this.manifestCursor });
			else files.push(save);
		}
		return page({ files, deleted, nextCursor: this.manifestCursor, serverTime: this.manifestTime });
	}

	private json(body: unknown): Promise<HttpResponse> {
		return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
	}
}

class FakeVault implements VaultPort {
	files = new Map<string, string>();
	writes: string[] = [];
	renames: [string, string][] = [];
	trashed: string[] = [];
	copies: [string, string][] = [];
	/** 1-based index of the write call that throws. */
	failOnWrite: number | null = null;

	listMarkdown(root: string): Promise<string[]> {
		return Promise.resolve(
			[...this.files.keys()].filter((p) => p.startsWith(`${root}/`) && p.endsWith('.md')),
		);
	}

	uuidOf(path: string): Promise<string | null> {
		const text = this.files.get(path);
		if (text === undefined || frontmatterField(text, 'saive_schema') === null) {
			return Promise.resolve(null);
		}
		return Promise.resolve(frontmatterField(text, 'uuid'));
	}

	read(path: string): Promise<string> {
		const text = this.files.get(path);
		if (text === undefined) return Promise.reject(new Error(`no file ${path}`));
		return Promise.resolve(text);
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}

	write(path: string, markdown: string): Promise<void> {
		this.writes.push(path);
		if (this.failOnWrite === this.writes.length) return Promise.reject(new Error('disk full'));
		this.files.set(path, markdown);
		return Promise.resolve();
	}

	rename(from: string, to: string): Promise<void> {
		const text = this.files.get(from);
		if (text === undefined) return Promise.reject(new Error(`no file ${from}`));
		if (this.files.has(to)) return Promise.reject(new Error(`exists ${to}`));
		this.files.delete(from);
		this.files.set(to, text);
		this.renames.push([from, to]);
		return Promise.resolve();
	}

	trash(path: string): Promise<void> {
		if (!this.files.has(path)) return Promise.reject(new Error(`no file ${path}`));
		this.files.delete(path);
		this.trashed.push(path);
		return Promise.resolve();
	}

	async copy(from: string, to: string): Promise<void> {
		if (this.files.has(to)) throw new Error(`exists ${to}`);
		this.files.set(to, await this.read(from));
		this.copies.push([from, to]);
	}
}

class FakeStore implements StatePort {
	saved: SyncState[] = [];

	constructor(private current: SyncState | null) {}

	load(): Promise<SyncState | null> {
		return Promise.resolve(this.current === null ? null : structuredClone(this.current));
	}

	save(state: SyncState): Promise<void> {
		this.current = structuredClone(state);
		this.saved.push(structuredClone(state));
		return Promise.resolve();
	}

	get state(): SyncState {
		if (this.current === null) throw new Error('no state saved');
		return this.current;
	}
}

interface World {
	server: FakeServer;
	vault: FakeVault;
	store: FakeStore;
	engine: SyncEngine;
	confirms: [number, number][];
	logs: string[];
}

function world(
	over: {
		state?: SyncState | null;
		confirm?: (count: number, tracked: number) => boolean;
		engine?: Partial<SyncEngineOptions>;
	} = {},
): World {
	const server = new FakeServer();
	const vault = new FakeVault();
	const store = new FakeStore(over.state ?? null);
	const confirms: [number, number][] = [];
	const logs: string[] = [];
	const engine = new SyncEngine({
		client: new SyncClient({
			baseUrl: 'https://app.saive.my',
			http: server,
			token: () => Promise.resolve('sv_obs_test'),
			pluginVersion: '0.0.1',
		}),
		vault,
		state: store,
		root: ROOT,
		log: (m) => logs.push(m),
		confirmMassTrash: (count, tracked) => {
			confirms.push([count, tracked]);
			return Promise.resolve(over.confirm === undefined ? true : over.confirm(count, tracked));
		},
		...over.engine,
	});
	return { server, vault, store, engine, confirms, logs };
}

/** Seed `count` saves through a real first sync, so state and disk agree. */
async function seeded(count: number, over: Parameters<typeof world>[0] = {}): Promise<World> {
	const w = world(over);
	const files = Array.from({ length: count }, (_, i) => file(i + 1));
	w.server.feed.set('0', page({ files, nextCursor: String(count) }));
	for (const f of files) w.server.saves.set(f.uuid, f);
	w.server.manifestCursor = String(count);
	const report = await w.engine.sync();
	expect(report.written).toBe(count);
	w.server.calls = [];
	w.vault.writes = [];
	w.store.saved = [];
	return w;
}

async function tracked(w: World, n: number, markdown: string, path = `${ROOT}/Save ${n}.md`) {
	w.vault.files.set(path, markdown);
	w.store.state.files[uuidN(n)] = {
		path,
		fullHash: await fullHash(markdown),
		bodyHash: await bodyHash(markdown),
		remoteFolder: null,
		seq: String(n),
	};
}

describe('SyncEngine first sync and resume', () => {
	it('(a) writes every file across two pages and persists state after each', async () => {
		const w = world();
		w.server.feed.set('0', page({ files: [file(1), file(2, { folder: 'Recipes' })], nextCursor: '2', hasMore: true }));
		w.server.feed.set('2', page({ files: [file(3)], nextCursor: '3' }));

		const report = await w.engine.sync();

		expect(report).toEqual({
			pages: 2,
			written: 3,
			renamed: 0,
			trashed: 0,
			conflicts: 0,
			skipped: 0,
			fetched: 0,
			reconciled: false,
		});
		expect([...w.vault.files.keys()].sort()).toEqual([
			'Saive/Recipes/Save 2.md',
			'Saive/Save 1.md',
			'Saive/Save 3.md',
		]);
		expect(w.vault.files.get('Saive/Save 1.md')).toBe(file(1).markdown);
		expect(w.store.saved.map((s) => s.cursor)).toEqual(['2', '3']);
		expect(w.store.saved[0]?.files[uuidN(1)]?.path).toBe('Saive/Save 1.md');
		expect(w.store.saved[0]?.files[uuidN(3)]).toBeUndefined();
		expect(w.store.state.files[uuidN(2)]?.remoteFolder).toBe('Recipes');
		// The pull from cursor 0 is the reconcile baseline.
		expect(w.store.state.lastReconcileServerTime).toBe(T0);
		expect(w.server.pulls()).toEqual([
			'https://app.saive.my/api/sync/pull?since=0',
			'https://app.saive.my/api/sync/pull?since=2',
		]);
	});

	it('(b) a crash on page 2 keeps the cursor at page 1, and the next sync resumes without rewriting', async () => {
		const w = world();
		w.server.feed.set('0', page({ files: [file(1), file(2)], nextCursor: '2', hasMore: true }));
		w.server.feed.set('2', page({ files: [file(3), file(4)], nextCursor: '4' }));
		w.vault.failOnWrite = 3;

		await expect(w.engine.sync()).rejects.toThrow('disk full');

		expect(w.store.saved.map((s) => s.cursor)).toEqual(['2']);
		expect([...w.vault.files.keys()].sort()).toEqual(['Saive/Save 1.md', 'Saive/Save 2.md']);

		w.vault.failOnWrite = null;
		const report = await w.engine.sync();

		expect(report.written).toBe(2);
		expect(w.store.state.cursor).toBe('4');
		expect(w.vault.writes.filter((p) => p === 'Saive/Save 1.md')).toHaveLength(1);
		expect(w.vault.writes.filter((p) => p === 'Saive/Save 2.md')).toHaveLength(1);
		expect(w.server.pulls().at(-1)).toBe('https://app.saive.my/api/sync/pull?since=2');
	});

	it('(c) a second sync with no remote changes writes nothing and changes no state but the cursor', async () => {
		const w = await seeded(3);
		const before = structuredClone(w.store.state);
		w.server.feed.set('3', page({ nextCursor: '3' }));

		const report = await w.engine.sync();

		expect(report.written).toBe(0);
		expect(report.pages).toBe(1);
		expect(w.vault.writes).toEqual([]);
		expect(w.store.saved).toHaveLength(1);
		expect(w.store.state).toEqual({ ...before, cursor: '3' });
	});

	it('re-pulling an applied page writes nothing: equal bytes mean skip', async () => {
		const w = await seeded(2);
		w.server.feed.set('2', page({ files: [file(1), file(2)], nextCursor: '2' }));
		const report = await w.engine.sync();
		expect(report.written).toBe(0);
		expect(report.skipped).toBe(2);
	});

	it('loads a state written before tombstones existed', async () => {
		const legacy = { cursor: '0', lastReconcileServerTime: null, files: {} } as SyncState;
		const w = world({ state: legacy });
		w.server.feed.set('0', page({ files: [file(1)], nextCursor: '1' }));
		const report = await w.engine.sync();
		expect(report.written).toBe(1);
		expect(w.store.state.ignored).toEqual({});
	});
});

describe('SyncEngine mass-trash guard', () => {
	it('massTrashLimit is max(20, 10% of tracked)', () => {
		expect(massTrashLimit(0)).toBe(20);
		expect(massTrashLimit(100)).toBe(20);
		expect(massTrashLimit(250)).toBe(25);
		expect(massTrashLimit(1001)).toBe(101);
	});

	it('(d) a page that deletes every tracked file asks first; no means nothing moves', async () => {
		const w = await seeded(30, { confirm: () => false });
		w.server.feed.set('30', page({
			deleted: Array.from({ length: 30 }, (_, i) => ({ uuid: uuidN(i + 1), seq: String(31 + i) })),
			nextCursor: '60',
		}));

		const report = await w.engine.sync();

		expect(report.aborted).toBe('mass-trash');
		expect(report.trashed).toBe(0);
		expect(w.confirms).toEqual([[30, 30]]);
		expect(w.vault.trashed).toEqual([]);
		expect(w.vault.files.size).toBe(30);
		expect(w.store.saved).toEqual([]);
		expect(w.store.state.cursor).toBe('30');
	});

	it('(d) yes trashes them and advances', async () => {
		const w = await seeded(30, { confirm: () => true });
		w.server.feed.set('30', page({
			deleted: Array.from({ length: 30 }, (_, i) => ({ uuid: uuidN(i + 1), seq: String(31 + i) })),
			nextCursor: '60',
		}));

		const report = await w.engine.sync();

		expect(report.aborted).toBeUndefined();
		expect(report.trashed).toBe(30);
		expect(w.confirms).toEqual([[30, 30]]);
		expect(w.vault.files.size).toBe(0);
		expect(w.store.state.cursor).toBe('60');
		expect(Object.keys(w.store.state.files)).toEqual([]);
	});

	it('(e) 21 deletes of 100 tracked trigger the guard; 10 do not', async () => {
		const deletes = (n: number) =>
			page({
				deleted: Array.from({ length: n }, (_, i) => ({ uuid: uuidN(i + 1), seq: String(101 + i) })),
				nextCursor: '200',
			});

		const asked = await seeded(100, { confirm: () => false });
		asked.server.feed.set('100', deletes(21));
		expect((await asked.engine.sync()).aborted).toBe('mass-trash');
		expect(asked.confirms).toEqual([[21, 100]]);
		expect(asked.vault.trashed).toEqual([]);

		const quiet = await seeded(100, { confirm: () => false });
		quiet.server.feed.set('100', deletes(10));
		const report = await quiet.engine.sync();
		expect(report.aborted).toBeUndefined();
		expect(report.trashed).toBe(10);
		expect(quiet.confirms).toEqual([]);
	});

	it('a body-edited file survives a remote delete and never counts toward the guard', async () => {
		const w = await seeded(2);
		w.vault.files.set('Saive/Save 1.md', md(uuidN(1), 'Save 1', 'My own words.'));
		w.server.feed.set('2', page({
			deleted: [{ uuid: uuidN(1), seq: '3' }, { uuid: uuidN(2), seq: '4' }],
			nextCursor: '4',
		}));
		const report = await w.engine.sync();
		expect(report.trashed).toBe(1);
		expect(report.skipped).toBe(1);
		expect(w.vault.trashed).toEqual(['Saive/Save 2.md']);
		expect(w.vault.files.has('Saive/Save 1.md')).toBe(true);
		expect(w.logs).toContain(`Skipped ${uuidN(1)}: body-edited-delete`);
	});
});

describe('SyncEngine errors', () => {
	it('(f) 401 aborts as unlinked with state untouched', async () => {
		const w = await seeded(1);
		w.server.fail = { status: 401 };
		const report = await w.engine.sync();
		expect(report.aborted).toBe('unlinked');
		expect(w.store.saved).toEqual([]);
	});

	it('(f) 429 aborts as rate-limited with the header seconds', async () => {
		const w = await seeded(1);
		w.server.fail = { status: 429, headers: { 'retry-after': '42' } };
		const report = await w.engine.sync();
		expect(report.aborted).toBe('rate-limited');
		expect(report.retryAfterSeconds).toBe(42);
	});

	it('a missing token aborts as unlinked before any request', async () => {
		const w = world({
			engine: {
				client: new SyncClient({
					baseUrl: 'https://app.saive.my',
					http: { get: () => Promise.reject(new Error('should not be called')) },
					token: () => Promise.resolve(null),
					pluginVersion: '0.0.1',
				}),
			},
		});
		const report = await w.engine.sync();
		expect(report.aborted).toBe('unlinked');
	});

	it('a server error on page 2 propagates with page 1 saved', async () => {
		const w = world();
		w.server.feed.set('0', page({ files: [file(1)], nextCursor: '1', hasMore: true }));
		w.server.fail = { status: 500, afterCalls: 1 };
		await expect(w.engine.sync()).rejects.toBeInstanceOf(ServerError);
		expect(w.store.saved.map((s) => s.cursor)).toEqual(['1']);
		expect(w.vault.files.has('Saive/Save 1.md')).toBe(true);
	});
});

describe('SyncEngine reconcile', () => {
	it('(g) reset: true triggers a reconcile, then pulls again from the manifest cursor', async () => {
		const w = await seeded(2);
		w.server.feed.set('2', page({ reset: true, nextCursor: '1' }));
		w.server.manifestCursor = '1';
		w.server.feed.set('1', page({ nextCursor: '1' }));

		const report = await w.engine.sync();

		expect(report.reconciled).toBe(true);
		expect(w.store.state.cursor).toBe('1');
		expect(w.server.calls).toEqual([
			'https://app.saive.my/api/sync/pull?since=2',
			'https://app.saive.my/api/sync/manifest',
			'https://app.saive.my/api/sync/pull?since=1',
		]);
	});

	it('(g) a 26-day gap since the last reconcile triggers one; 24 days does not', async () => {
		const stale = await seeded(1);
		stale.server.feed.set('1', page({ nextCursor: '1', serverTime: after(26) }));
		stale.server.manifestCursor = '1';
		stale.server.manifestTime = after(26);
		const report = await stale.engine.sync();
		expect(report.reconciled).toBe(true);
		expect(stale.store.state.lastReconcileServerTime).toBe(after(26));

		const fresh = await seeded(1);
		fresh.server.feed.set('1', page({ nextCursor: '1', serverTime: after(24) }));
		expect((await fresh.engine.sync()).reconciled).toBe(false);
		expect(fresh.server.calls.some((c) => c.includes('manifest'))).toBe(false);
	});

	it('(g) full: true clears ignored, so a user-deleted save comes back', async () => {
		const w = await seeded(2);
		w.vault.files.delete('Saive/Save 2.md');
		w.server.feed.set('2', page({ files: [file(2, { seq: '3' })], nextCursor: '3' }));
		w.server.saves.set(uuidN(2), file(2, { seq: '3' }));
		w.server.manifestCursor = '3';
		expect((await w.engine.sync()).skipped).toBe(1);
		expect(w.store.state.ignored).toEqual({ [uuidN(2)]: '3' });
		expect(w.vault.files.has('Saive/Save 2.md')).toBe(false);

		// Plain sync: the tombstone holds, no pull by uuid.
		w.server.feed.set('3', page({ nextCursor: '3' }));
		expect((await w.engine.sync()).written).toBe(0);
		expect(w.vault.files.has('Saive/Save 2.md')).toBe(false);

		const report = await w.engine.sync({ full: true });
		expect(report.reconciled).toBe(true);
		expect(report.written).toBe(1);
		expect(w.store.state.ignored).toEqual({});
		expect(w.vault.files.has('Saive/Save 2.md')).toBe(true);
	});

	it('(h) trashes a tracked save the manifest lacks and pulls a manifest save the state lacks', async () => {
		const w = await seeded(2);
		w.server.saves.delete(uuidN(1));
		w.server.saves.set(uuidN(3), file(3));
		w.server.manifestCursor = '3';
		w.server.manifestTime = after(1);
		w.server.feed.set('3', page({ nextCursor: '3' }));

		const report = await w.engine.sync({ full: true });

		expect(report.trashed).toBe(1);
		expect(report.written).toBe(1);
		expect(w.vault.trashed).toEqual(['Saive/Save 1.md']);
		expect(w.vault.files.has('Saive/Save 3.md')).toBe(true);
		expect(w.store.state.files[uuidN(1)]).toBeUndefined();
		expect(w.store.state.files[uuidN(3)]?.seq).toBe('3');
		expect(w.store.state.cursor).toBe('3');
		expect(w.store.state.lastReconcileServerTime).toBe(after(1));
		expect(w.server.calls).toContain(
			`https://app.saive.my/api/sync/pull?since=0&uuids=${uuidN(3)}`,
		);
	});

	it('pulls a save whose manifest seq is newer than the state, and leaves a current one alone', async () => {
		const w = await seeded(2);
		const newer = file(1, { seq: '9', markdown: md(uuidN(1), 'Save 1', 'Newer body.') });
		w.server.saves.set(uuidN(1), newer);
		w.server.manifestCursor = '9';
		w.server.feed.set('9', page({ nextCursor: '9' }));

		const report = await w.engine.sync({ full: true });

		expect(report.written).toBe(1);
		expect(w.vault.files.get('Saive/Save 1.md')).toBe(newer.markdown);
		const uuidPulls = w.server.calls.filter((c) => c.includes('uuids='));
		expect(uuidPulls).toEqual([`https://app.saive.my/api/sync/pull?since=0&uuids=${uuidN(1)}`]);
	});

	it('batches uuid pulls 25 at a time and keeps the cursor until the end', async () => {
		const w = world();
		w.server.feed.set('0', page({ reset: true, nextCursor: '0' }));
		for (let i = 1; i <= 30; i++) w.server.saves.set(uuidN(i), file(i));
		w.server.manifestCursor = '30';
		w.server.feed.set('30', page({ nextCursor: '30' }));

		const report = await w.engine.sync();

		expect(report.written).toBe(30);
		const uuidPulls = w.server.calls.filter((c) => c.includes('uuids='));
		expect(uuidPulls).toHaveLength(2);
		expect(uuidPulls[0]?.split(',')).toHaveLength(25);
		expect(uuidPulls[1]?.split(',')).toHaveLength(5);
		// Two uuid pages saved with the cursor held, then the final stamp.
		expect(w.store.saved.map((s) => s.cursor)).toEqual(['0', '0', '30', '30']);
	});

	it('the mass-trash guard covers reconcile deletes', async () => {
		const w = await seeded(30, { confirm: () => false });
		w.server.saves.clear();
		w.server.manifestTime = after(1);
		const report = await w.engine.sync({ full: true });
		expect(report.aborted).toBe('mass-trash');
		expect(w.confirms).toEqual([[30, 30]]);
		expect(w.vault.trashed).toEqual([]);
		expect(w.store.state.lastReconcileServerTime).toBe(T0);
	});

	it('drops a tombstone the server has also dropped', async () => {
		const w = await seeded(1);
		w.store.state.ignored[uuidN(7)] = '5';
		w.server.feed.set('1', page({ reset: true, nextCursor: '1' }));
		w.server.manifestCursor = '2';
		w.server.feed.set('2', page({ nextCursor: '2' }));
		await w.engine.sync();
		expect(w.store.state.ignored).toEqual({});
		expect(w.vault.files.size).toBe(1);
	});
});

describe('SyncEngine oversize', () => {
	it('(i) fetches an oversize save and writes it under its frontmatter title', async () => {
		const w = world();
		const big = md(uuidN(9), 'A big one', 'x'.repeat(100));
		w.server.feed.set('0', page({ oversize: [{ uuid: uuidN(9), seq: '9' }], nextCursor: '9' }));
		w.server.files.set(uuidN(9), big);

		const report = await w.engine.sync();

		expect(report.fetched).toBe(1);
		expect(report.written).toBe(1);
		expect(w.vault.files.get('Saive/A big one.md')).toBe(big);
		expect(w.store.state.files[uuidN(9)]).toMatchObject({ path: 'Saive/A big one.md', seq: '9', remoteFolder: null });
		expect(w.store.state.cursor).toBe('9');
	});

	it('keeps a tracked oversize save in its recorded folder', async () => {
		const w = world();
		const first = file(9, { folder: 'Recipes', title: 'Cake' });
		w.server.feed.set('0', page({ files: [first], nextCursor: '9', hasMore: true }));
		const big = md(uuidN(9), 'Cake', 'y'.repeat(100));
		w.server.feed.set('9', page({ oversize: [{ uuid: uuidN(9), seq: '10' }], nextCursor: '10' }));
		w.server.files.set(uuidN(9), big);

		const report = await w.engine.sync();

		expect(report.written).toBe(2);
		expect(w.vault.files.get('Saive/Recipes/Cake.md')).toBe(big);
		expect(w.vault.renames).toEqual([]);
	});

	it('uses folder and title from the oversize entry when the server sends them', async () => {
		const w = world();
		const big = md(uuidN(9), 'Old title', 'z');
		w.server.feed.set('0', page({
			oversize: [{ uuid: uuidN(9), seq: '9', folder: 'Big', title: 'New title' }],
			nextCursor: '9',
		}));
		w.server.files.set(uuidN(9), big);
		await w.engine.sync();
		expect(w.vault.files.get('Saive/Big/New title.md')).toBe(big);
	});

	it('skips an oversize save whose file route answers 404', async () => {
		const w = world();
		w.server.feed.set('0', page({ oversize: [{ uuid: uuidN(9), seq: '9' }], nextCursor: '9' }));
		const report = await w.engine.sync();
		expect(report.fetched).toBe(0);
		expect(report.skipped).toBe(1);
		expect(report.written).toBe(0);
		expect(w.store.state.cursor).toBe('9');
	});
});

describe('SyncEngine conflicts, moves and occupied paths', () => {
	it('copies a body-edited file to _conflicts before overwriting, and never touches the copy again', async () => {
		const w = await seeded(1);
		w.vault.files.set('Saive/Save 1.md', md(uuidN(1), 'Save 1', 'My edit.'));
		const remote = file(1, { seq: '2', markdown: md(uuidN(1), 'Save 1', 'Remote edit.') });
		w.server.feed.set('1', page({ files: [remote], nextCursor: '2' }));

		const report = await w.engine.sync();

		expect(report.conflicts).toBe(1);
		expect(report.written).toBe(1);
		const copy = 'Saive/_conflicts/Save 1 (conflict 2026-09-17).md';
		expect(w.vault.copies).toEqual([['Saive/Save 1.md', copy]]);
		expect(w.vault.files.get(copy)).toContain('My edit.');
		expect(w.vault.files.get('Saive/Save 1.md')).toBe(remote.markdown);

		// The copy carries the same uuid. A remote delete trashes the synced
		// file alone; a user who removed the synced file keeps the copy too.
		w.server.feed.set('2', page({ deleted: [{ uuid: uuidN(1), seq: '3' }], nextCursor: '3' }));
		expect((await w.engine.sync()).trashed).toBe(1);
		expect(w.vault.trashed).toEqual(['Saive/Save 1.md']);
		expect(w.vault.files.has(copy)).toBe(true);

		w.server.feed.set('3', page({ files: [file(1, { seq: '4' })], nextCursor: '4' }));
		await w.engine.sync();
		expect(w.vault.files.get(copy)).toContain('My edit.');
		expect(w.vault.files.get('Saive/Save 1.md')).toBe(file(1).markdown);
	});

	it('moves a file the plugin placed under an old root into the current root', async () => {
		const w = world({ state: { ...emptyState(), cursor: '1', lastReconcileServerTime: T0 } });
		await tracked(w, 1, file(1).markdown, 'Old/Save 1.md');
		w.server.feed.set('1', page({ files: [file(1)], nextCursor: '1' }));

		const report = await w.engine.sync();

		expect(report.renamed).toBe(1);
		expect(w.vault.renames).toEqual([['Old/Save 1.md', 'Saive/Save 1.md']]);
		expect(w.store.state.files[uuidN(1)]?.path).toBe('Saive/Save 1.md');
	});

	it('leaves a file the user moved where it is, found through its frontmatter', async () => {
		const w = await seeded(1);
		const moved = 'Saive/Archive/Save 1.md';
		w.vault.files.set(moved, w.vault.files.get('Saive/Save 1.md') ?? '');
		w.vault.files.delete('Saive/Save 1.md');
		const remote = file(1, { seq: '2', markdown: md(uuidN(1), 'Save 1', 'Changed.') });
		w.server.feed.set('1', page({ files: [remote], nextCursor: '2' }));

		const report = await w.engine.sync();

		expect(report.renamed).toBe(0);
		expect(report.written).toBe(1);
		expect(w.vault.files.get(moved)).toBe(remote.markdown);
		expect(w.store.state.files[uuidN(1)]?.path).toBe(moved);
	});

	it('never writes over a note without a Saive uuid', async () => {
		const w = world();
		w.vault.files.set('Saive/Save 1.md', '# My own note\n');
		w.server.feed.set('0', page({ files: [file(1)], nextCursor: '1' }));
		await w.engine.sync();
		expect(w.vault.files.get('Saive/Save 1.md')).toBe('# My own note\n');
		expect(w.vault.files.get('Saive/Save 1 (00000000).md')).toBe(file(1).markdown);
	});

	it('marks a user-deleted file as ignored and skips later updates for it', async () => {
		const w = await seeded(1);
		w.vault.files.delete('Saive/Save 1.md');
		w.server.feed.set('1', page({ files: [file(1, { seq: '2' })], nextCursor: '2' }));
		expect((await w.engine.sync()).skipped).toBe(1);
		expect(w.store.state.ignored).toEqual({ [uuidN(1)]: '2' });
		w.server.feed.set('2', page({ files: [file(1, { seq: '3' })], nextCursor: '3' }));
		expect((await w.engine.sync()).written).toBe(0);
		expect(w.vault.files.has('Saive/Save 1.md')).toBe(false);
	});
});

describe('SyncEngine single flight', () => {
	it('(j) two concurrent sync() calls share one run; a later call starts a new one', async () => {
		const w = world();
		w.server.feed.set('0', page({ files: [file(1)], nextCursor: '1' }));
		const first = w.engine.sync();
		const second = w.engine.sync();
		expect(second).toBe(first);
		const [r1, r2] = await Promise.all([first, second]);
		expect(r1).toBe(r2);
		expect(w.server.pulls()).toHaveLength(1);

		w.server.feed.set('1', page({ nextCursor: '1' }));
		const third = w.engine.sync();
		expect(third).not.toBe(first);
		await third;
		expect(w.server.pulls()).toHaveLength(2);
	});

	it('a failed run releases the lock', async () => {
		const w = world();
		w.server.feed.set('0', page({ files: [file(1)], nextCursor: '1' }));
		w.vault.failOnWrite = 1;
		await expect(w.engine.sync()).rejects.toThrow('disk full');
		w.vault.failOnWrite = null;
		expect((await w.engine.sync()).written).toBe(1);
	});
});
