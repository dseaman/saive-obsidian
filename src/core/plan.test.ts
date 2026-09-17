import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareSeq, parsePullResponse } from './contract';
import type { PullFile, PullResponse } from './contract';
import { bodyHash, fullHash } from './hash';
import { planPage } from './plan';
import type {
	Action,
	FileState,
	LocalFile,
	LocalIndex,
	PlanOptions,
	SyncState,
} from './plan';

// planPage is the whole sync brain: it sees one page of changes, the plugin's
// last recorded state and what the adapter found on disk, and returns the
// actions to run. Every rule in the plan of record gets a table row here.
// Nothing in this file touches Obsidian; the adapter (P2) runs the actions.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../../contracts/obsidian-sync-v1.json', import.meta.url),
		),
		'utf8',
	),
) as { pullResponse: unknown };

const fixturePage = parsePullResponse(fixture.pullResponse);
const [FIXTURE_FILE_1, FIXTURE_FILE_2] = fixturePage.files as [PullFile, PullFile];

const ROOT = 'Saive';
const U1 = FIXTURE_FILE_1.uuid; // 3a4b5c6d..., "Example save" in Recipes
const U2 = FIXTURE_FILE_2.uuid; // 7e8f9a1b..., "Unfiled save"
const U3 = 'c9d8e7f6-1234-4a1b-9c2d-1e2f3a4b5c6d'; // the fixture's deleted uuid
const U4 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; // never on the fixture page
const MD1 = FIXTURE_FILE_1.markdown;
const MD2 = FIXTURE_FILE_2.markdown;
const P1 = 'Saive/Recipes/Example save.md';
const SERVER_TIME = '2026-09-17T19:00:00.000Z';

const bodyEdit = (md: string) => md.replace('Mine.', 'Local edit.');
const remoteEdit = (md: string) => md.replace('Mine.', 'Yours.');
const frontmatterEdit = (md: string) => md.replace('status: unread', 'status: read');

function page(over: Partial<PullResponse> = {}): PullResponse {
	return {
		files: [],
		deleted: [],
		missing: [],
		oversize: [],
		nextCursor: '2000',
		hasMore: false,
		reset: false,
		serverTime: SERVER_TIME,
		...over,
	};
}

function entry(over: Partial<PullFile> = {}): PullFile {
	return { ...FIXTURE_FILE_1, seq: '1100', ...over };
}

async function tracked(
	markdown: string,
	over: Partial<FileState> = {},
): Promise<FileState> {
	return {
		path: P1,
		fullHash: await fullHash(markdown),
		bodyHash: await bodyHash(markdown),
		remoteFolder: 'Recipes',
		seq: '1042',
		...over,
	};
}

async function onDisk(path: string, markdown: string): Promise<LocalFile> {
	return { path, fullHash: await fullHash(markdown), bodyHash: await bodyHash(markdown) };
}

function state(files: Record<string, FileState> = {}, over: Partial<SyncState> = {}): SyncState {
	return { cursor: '1000', lastReconcileServerTime: null, files, ...over };
}

const kinds = (actions: Action[]) => actions.map((a) => a.kind);

function only<K extends Action['kind']>(actions: Action[], kind: K): Extract<Action, { kind: K }> {
	const found = actions.filter((a): a is Extract<Action, { kind: K }> => a.kind === kind);
	expect(found).toHaveLength(1);
	return found[0]!;
}

const run = (
	s: SyncState,
	p: PullResponse,
	local: LocalIndex = {},
	opts: Partial<PlanOptions> = {},
) => planPage(s, p, local, { root: ROOT, ...opts });

describe('planPage on the fixture page from an empty state', () => {
	it('writes both files, skips the missing row and fetches the oversize one', async () => {
		const { actions, state: next } = await run(state(), fixturePage);
		expect(kinds(actions)).toEqual(['write', 'write', 'skip', 'fetch']);
		expect(actions[0]).toEqual({ kind: 'write', uuid: U1, path: P1, markdown: MD1 });
		expect(actions[1]).toEqual({
			kind: 'write',
			uuid: U2,
			path: 'Saive/Unfiled save.md',
			markdown: MD2,
		});
		expect(actions[2]).toEqual({
			kind: 'skip',
			uuid: '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9',
			reason: 'missing-remote',
		});
		expect(actions[3]).toEqual({
			kind: 'fetch',
			uuid: '11111111-2222-4333-8444-555555555555',
			seq: '1046',
		});
		expect(Object.keys(next.files).sort()).toEqual([U1, U2].sort());
		expect(next.files[U1]).toEqual({
			path: P1,
			fullHash: await fullHash(MD1),
			bodyHash: await bodyHash(MD1),
			remoteFolder: 'Recipes',
			seq: '1042',
		});
		expect(next.files[U2]?.remoteFolder).toBeNull();
		expect(next.cursor).toBe('1046');
	});
});

describe('unchanged files', () => {
	it('writes nothing when the local bytes equal the incoming bytes', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(s, page({ files: [entry()] }), {
			[U1]: [await onDisk(P1, MD1)],
		});
		expect(actions).toEqual([{ kind: 'skip', uuid: U1, reason: 'unchanged' }]);
		expect(next.files[U1]?.seq).toBe('1100');
		expect(next.files[U1]?.path).toBe(P1);
	});
});

describe('local edits', () => {
	it('overwrites a frontmatter-only local edit without a conflict copy', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const remote = remoteEdit(MD1);
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ markdown: remote })] }),
			{ [U1]: [await onDisk(P1, frontmatterEdit(MD1))] },
		);
		expect(kinds(actions)).toEqual(['write']);
		expect(only(actions, 'write')).toEqual({ kind: 'write', uuid: U1, path: P1, markdown: remote });
		expect(next.files[U1]?.fullHash).toBe(await fullHash(remote));
		expect(next.files[U1]?.bodyHash).toBe(await bodyHash(remote));
	});

	it('copies a body-edited file to _conflicts once, then writes', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const remote = remoteEdit(MD1);
		const { actions } = await run(s, page({ files: [entry({ markdown: remote })] }), {
			[U1]: [await onDisk(P1, bodyEdit(MD1))],
		});
		expect(kinds(actions)).toEqual(['conflict', 'write']);
		expect(only(actions, 'conflict')).toEqual({
			kind: 'conflict',
			uuid: U1,
			path: P1,
			copyPath: 'Saive/_conflicts/Example save (conflict 2026-09-17).md',
		});
		expect(only(actions, 'write').markdown).toBe(remote);
	});

	it('writes without a conflict when the local body already equals the remote body', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const remote = frontmatterEdit(remoteEdit(MD1));
		const { actions } = await run(s, page({ files: [entry({ markdown: remote })] }), {
			[U1]: [await onDisk(P1, remoteEdit(MD1))],
		});
		expect(kinds(actions)).toEqual(['write']);
	});

	it('honors conflictsDir and suffixes a taken conflict path', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const p = page({ files: [entry({ markdown: remoteEdit(MD1) })] });
		const local = { [U1]: [await onDisk(P1, bodyEdit(MD1))] };
		const a = await run(s, p, local, { conflictsDir: 'Conflicts' });
		expect(only(a.actions, 'conflict').copyPath).toBe(
			'Conflicts/Example save (conflict 2026-09-17).md',
		);
		const b = await run(s, p, local, {
			occupied: ['Saive/_conflicts/example save (CONFLICT 2026-09-17).md'],
		});
		expect(only(b.actions, 'conflict').copyPath).toBe(
			'Saive/_conflicts/Example save (conflict 2026-09-17) (3a4b5c6d).md',
		);
	});

	it('keeps the conflict copy stem within 120 code points', async () => {
		const long = 'x'.repeat(200);
		const longPath = `Saive/Recipes/${'x'.repeat(120)}.md`;
		const s = state({ [U1]: await tracked(MD1, { path: longPath }) });
		const { actions } = await run(
			s,
			page({ files: [entry({ title: long, markdown: remoteEdit(MD1) })] }),
			{ [U1]: [await onDisk(longPath, bodyEdit(MD1))] },
		);
		const copy = only(actions, 'conflict').copyPath;
		const stem = copy.slice('Saive/_conflicts/'.length, -'.md'.length);
		expect(Array.from(stem)).toHaveLength(120);
		expect(stem.endsWith(' (conflict 2026-09-17)')).toBe(true);
	});
});

describe('user moves and remote renames', () => {
	it('leaves a user-moved file where it is and writes a remote change in place', async () => {
		const moved = 'Saive/Archive/mine.md';
		const s = state({ [U1]: await tracked(MD1) });
		const remote = remoteEdit(MD1);
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ title: 'Renamed', folder: 'Elsewhere', markdown: remote })] }),
			{ [U1]: [await onDisk(moved, MD1)] },
		);
		expect(kinds(actions)).toEqual(['write']);
		expect(only(actions, 'write').path).toBe(moved);
		expect(next.files[U1]?.path).toBe(moved);
		expect(next.files[U1]?.remoteFolder).toBe('Elsewhere');
	});

	it('records a user move even when the bytes are unchanged', async () => {
		const moved = 'Saive/Archive/mine.md';
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(s, page({ files: [entry()] }), {
			[U1]: [await onDisk(moved, MD1)],
		});
		expect(kinds(actions)).toEqual(['skip']);
		expect(next.files[U1]?.path).toBe(moved);
	});

	it('renames a file still at the recorded path when the remote title changes', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ title: 'Renamed' })] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(actions).toEqual([
			{ kind: 'rename', uuid: U1, from: P1, to: 'Saive/Recipes/Renamed.md' },
		]);
		expect(next.files[U1]?.path).toBe('Saive/Recipes/Renamed.md');
	});

	it('renames then writes when both the title and the bytes changed', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const remote = remoteEdit(MD1);
		const { actions } = await run(
			s,
			page({ files: [entry({ title: 'Renamed', markdown: remote })] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(kinds(actions)).toEqual(['rename', 'write']);
		expect(only(actions, 'write').path).toBe('Saive/Recipes/Renamed.md');
	});

	it('renames across folders and records the new remote folder', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ folder: null })] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(only(actions, 'rename').to).toBe('Saive/Example save.md');
		expect(next.files[U1]?.remoteFolder).toBeNull();
	});

	it('treats a case-only title change as a rename', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions } = await run(
			s,
			page({ files: [entry({ title: 'Example Save' })] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(only(actions, 'rename').to).toBe('Saive/Recipes/Example Save.md');
	});

	it('does not rename a file whose recorded path carries a collision suffix', async () => {
		const suffixed = 'Saive/Recipes/Example save (3a4b5c6d).md';
		const s = state({ [U1]: await tracked(MD1, { path: suffixed }) });
		const { actions } = await run(s, page({ files: [entry()] }), {
			[U1]: [await onDisk(suffixed, MD1)],
		});
		expect(kinds(actions)).toEqual(['skip']);
	});

	it('suffixes a rename target that another tracked file holds', async () => {
		const s = state({
			[U1]: await tracked(MD1),
			[U2]: await tracked(MD2, { path: 'Saive/Recipes/Renamed.md', remoteFolder: 'Recipes' }),
		});
		const { actions } = await run(
			s,
			page({ files: [entry({ title: 'Renamed' })] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(only(actions, 'rename').to).toBe('Saive/Recipes/Renamed (3a4b5c6d).md');
	});
});

describe('new files', () => {
	it('writes a new uuid at the built path and records it', async () => {
		const { actions, state: next } = await run(state(), page({ files: [entry()] }));
		expect(actions).toEqual([{ kind: 'write', uuid: U1, path: P1, markdown: MD1 }]);
		expect(next.files[U1]).toEqual({
			path: P1,
			fullHash: await fullHash(MD1),
			bodyHash: await bodyHash(MD1),
			remoteFolder: 'Recipes',
			seq: '1100',
		});
	});

	it('avoids every path in state, on disk and in occupied', async () => {
		const suffixed = 'Saive/Recipes/Example save (3a4b5c6d).md';
		const viaState = await run(
			state({ [U2]: await tracked(MD2, { path: P1 }) }),
			page({ files: [entry()] }),
		);
		expect(only(viaState.actions, 'write').path).toBe(suffixed);

		const viaDisk = await run(state(), page({ files: [entry()] }), {
			[U2]: [await onDisk(P1, MD2)],
		});
		expect(only(viaDisk.actions, 'write').path).toBe(suffixed);

		const viaOccupied = await run(state(), page({ files: [entry()] }), {}, {
			occupied: [P1.toUpperCase()],
		});
		expect(only(viaOccupied.actions, 'write').path).toBe(suffixed);
	});

	it('suffixes the second of two new files that share a title', async () => {
		const { actions } = await run(
			state(),
			page({
				files: [
					entry({ uuid: U1, seq: '10' }),
					entry({ uuid: U2, seq: '11', markdown: MD2 }),
				],
			}),
		);
		expect(actions.map((a) => (a.kind === 'write' ? a.path : a.kind))).toEqual([
			P1,
			'Saive/Recipes/Example save (7e8f9a1b).md',
		]);
	});
});

describe('adopting an untracked local file that carries the uuid', () => {
	it('skips when the bytes match and records the path', async () => {
		const copy = 'Saive/Somewhere/copy.md';
		const { actions, state: next } = await run(state(), page({ files: [entry()] }), {
			[U1]: [await onDisk(copy, MD1)],
		});
		expect(kinds(actions)).toEqual(['skip']);
		expect(next.files[U1]?.path).toBe(copy);
	});

	it('preserves a differing body with a conflict copy', async () => {
		const copy = 'Saive/Somewhere/copy.md';
		const { actions } = await run(state(), page({ files: [entry()] }), {
			[U1]: [await onDisk(copy, bodyEdit(MD1))],
		});
		expect(kinds(actions)).toEqual(['conflict', 'write']);
		expect(only(actions, 'conflict').copyPath).toBe(
			'Saive/_conflicts/copy (conflict 2026-09-17).md',
		);
	});

	it('overwrites a frontmatter-only difference in place', async () => {
		const copy = 'Saive/Somewhere/copy.md';
		const { actions } = await run(state(), page({ files: [entry()] }), {
			[U1]: [await onDisk(copy, frontmatterEdit(MD1))],
		});
		expect(kinds(actions)).toEqual(['write']);
		expect(only(actions, 'write').path).toBe(copy);
	});
});

describe('deletes', () => {
	const del = (seq = '1100') => page({ deleted: [{ uuid: U1, seq }] });

	it('trashes a file whose body the user left alone', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(s, del(), {
			[U1]: [await onDisk(P1, frontmatterEdit(MD1))],
		});
		expect(actions).toEqual([{ kind: 'trash', uuid: U1, path: P1 }]);
		expect(next.files[U1]).toBeUndefined();
	});

	it('keeps a body-edited file and forgets it', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(s, del(), {
			[U1]: [await onDisk(P1, bodyEdit(MD1))],
		});
		expect(actions).toEqual([{ kind: 'skip', uuid: U1, reason: 'body-edited-delete' }]);
		expect(next.files[U1]).toBeUndefined();
	});

	it('forgets a tracked uuid with no file and does nothing else', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(s, del());
		expect(actions).toEqual([]);
		expect(next.files[U1]).toBeUndefined();
	});

	it('never trashes a file the plugin did not record', async () => {
		const { actions, state: next } = await run(state(), del(), {
			[U1]: [await onDisk(P1, MD1)],
		});
		expect(actions).toEqual([]);
		expect(next.files[U1]).toBeUndefined();
	});
});

describe('seq ordering', () => {
	it('delete then recreate keeps the file', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const remote = remoteEdit(MD1);
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ seq: '1050', markdown: remote })], deleted: [{ uuid: U1, seq: '1044' }] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(kinds(actions)).toEqual(['write']);
		expect(next.files[U1]?.seq).toBe('1050');
	});

	it('recreate then delete trashes the file', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const { actions, state: next } = await run(
			s,
			page({ files: [entry({ seq: '1044' })], deleted: [{ uuid: U1, seq: '1050' }] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(kinds(actions)).toEqual(['trash']);
		expect(next.files[U1]).toBeUndefined();
	});

	it('applies entries by seq, not by list position', async () => {
		const { actions } = await run(
			state(),
			page({
				files: [
					entry({ uuid: U1, seq: '20' }),
					entry({ uuid: U2, seq: '9', title: 'Other', markdown: MD2 }),
				],
			}),
		);
		expect(actions.map((a) => a.uuid)).toEqual([U2, U1]);
	});

	it('keeps the highest-seq entry when a uuid repeats within files', async () => {
		const remote = remoteEdit(MD1);
		const { actions, state: next } = await run(
			state(),
			page({ files: [entry({ seq: '30', markdown: remote }), entry({ seq: '12' })] }),
		);
		expect(kinds(actions)).toEqual(['write']);
		expect(only(actions, 'write').markdown).toBe(remote);
		expect(next.files[U1]?.seq).toBe('30');
	});

	it('lets an oversize entry outrank an older file entry', async () => {
		const { actions } = await run(
			state(),
			page({ files: [entry({ seq: '12' })], oversize: [{ uuid: U1, seq: '30' }] }),
		);
		expect(actions).toEqual([{ kind: 'fetch', uuid: U1, seq: '30' }]);
	});
});

describe('duplicate uuid on disk', () => {
	it('resolves to the lexicographically smallest path, the same way every run', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const local = {
			[U1]: [await onDisk('Saive/z copy.md', MD1), await onDisk('Saive/a copy.md', MD1)],
		};
		const p = page({ files: [entry({ markdown: remoteEdit(MD1) })] });
		const first = await run(s, p, local);
		const second = await run(s, p, local);
		expect(first.actions).toEqual(second.actions);
		expect(only(first.actions, 'write').path).toBe('Saive/a copy.md');
		expect(first.state).toEqual(second.state);
	});

	it('prefers the recorded path over a smaller duplicate', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		const local = {
			[U1]: [await onDisk('Saive/a copy.md', MD1), await onDisk(P1, MD1)],
		};
		const { actions } = await run(s, page({ files: [entry({ markdown: remoteEdit(MD1) })] }), local);
		expect(only(actions, 'write').path).toBe(P1);
	});
});

describe('files the user deleted', () => {
	it('stay gone: the update is skipped and the uuid leaves the state', async () => {
		const s = state({ [U1]: await tracked(MD1) });
		for (const local of [{}, { [U1]: [] }]) {
			const { actions, state: next } = await run(
				s,
				page({ files: [entry({ markdown: remoteEdit(MD1) })] }),
				local,
			);
			expect(actions).toEqual([{ kind: 'skip', uuid: U1, reason: 'user-deleted' }]);
			expect(next.files[U1]).toBeUndefined();
			expect(next.cursor).toBe('2000');
		}
	});
});

describe('missing and oversize', () => {
	it('missing leaves the local file and the state entry alone', async () => {
		const before = await tracked(MD1);
		const s = state({ [U1]: before });
		const { actions, state: next } = await run(
			s,
			page({ missing: [{ uuid: U1, seq: '1100' }] }),
			{ [U1]: [await onDisk(P1, bodyEdit(MD1))] },
		);
		expect(actions).toEqual([{ kind: 'skip', uuid: U1, reason: 'missing-remote' }]);
		expect(next.files[U1]).toEqual(before);
		expect(next.cursor).toBe('2000');
	});

	it('oversize asks the adapter to fetch and leaves the state entry alone', async () => {
		const before = await tracked(MD1);
		const s = state({ [U1]: before });
		const { actions, state: next } = await run(
			s,
			page({ oversize: [{ uuid: U1, seq: '1100' }] }),
			{ [U1]: [await onDisk(P1, MD1)] },
		);
		expect(actions).toEqual([{ kind: 'fetch', uuid: U1, seq: '1100' }]);
		expect(next.files[U1]).toEqual(before);
		expect(next.cursor).toBe('2000');
	});
});

describe('cursor and state hygiene', () => {
	it('advances the cursor to nextCursor and keeps every recorded seq at or below it', async () => {
		const s = state(
			{ [U4]: await tracked(MD2, { path: 'Saive/old.md', remoteFolder: null, seq: '7' }) },
			{ lastReconcileServerTime: '2026-09-01T00:00:00.000Z' },
		);
		const { state: next } = await run(s, fixturePage);
		expect(next.cursor).toBe(fixturePage.nextCursor);
		expect(next.lastReconcileServerTime).toBe('2026-09-01T00:00:00.000Z');
		expect(next.files[U4]?.seq).toBe('7');
		for (const f of Object.values(next.files)) {
			expect(compareSeq(f.seq, next.cursor)).toBeLessThanOrEqual(0);
		}
	});

	it('never mutates its inputs and returns fresh objects', async () => {
		const s = deepFreeze(state({ [U1]: await tracked(MD1), [U3]: await tracked(MD2, { path: 'Saive/old.md' }) }));
		const p = deepFreeze(page({ files: [entry({ markdown: remoteEdit(MD1) })], deleted: [{ uuid: U3, seq: '1101' }] }));
		const local = deepFreeze({ [U1]: [await onDisk(P1, bodyEdit(MD1))], [U3]: [await onDisk('Saive/old.md', MD2)] });
		const { actions, state: next } = await run(s, p, local);
		expect(kinds(actions)).toEqual(['conflict', 'write', 'trash']);
		expect(next).not.toBe(s);
		expect(next.files).not.toBe(s.files);
		expect(next.files[U1]).not.toBe(s.files[U1]);
		expect(s.files[U3]).toBeDefined();
		expect(next.files[U3]).toBeUndefined();
	});

	it('passes the server bytes through untouched', async () => {
		const md = '---\r\ntitle: x\r\n---\r\n\r\nBody  \r\n';
		const { actions } = await run(state(), page({ files: [entry({ markdown: md })] }));
		expect(only(actions, 'write').markdown).toBe(md);
	});
});

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		Object.freeze(value);
		for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
	}
	return value;
}
