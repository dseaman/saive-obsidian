import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ContractError,
	compareSeq,
	parseManifestResponse,
	parsePullResponse,
} from './contract';

// The guards are the only door wire data passes through. They must accept
// both fixture samples byte for byte and refuse anything with a wrong type,
// naming the field so a contract drift shows up as one readable error
// instead of a crash deep in planPage.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../../contracts/obsidian-sync-v1.json', import.meta.url),
		),
		'utf8',
	),
) as { pullResponse: unknown; manifestResponse: unknown };

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function fieldOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof ContractError) return error.field;
		throw error;
	}
	throw new Error('expected a ContractError');
}

type Loose = Record<string, unknown>;

describe('parsePullResponse', () => {
	it('accepts the fixture sample verbatim', () => {
		const parsed = parsePullResponse(fixture.pullResponse);
		expect(parsed).toEqual(fixture.pullResponse);
		expect(parsed.files[1]?.folder).toBeNull();
		expect(parsed.nextCursor).toBe('1046');
	});

	it('rejects a non-object', () => {
		expect(fieldOf(() => parsePullResponse(null))).toBe('$');
		expect(fieldOf(() => parsePullResponse('nope'))).toBe('$');
	});

	it('names a wrong-typed seq inside files', () => {
		const page = clone(fixture.pullResponse) as Loose;
		(page.files as Loose[])[0]!.seq = 1042;
		const error = (() => {
			try {
				parsePullResponse(page);
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(error).toBeInstanceOf(ContractError);
		expect((error as ContractError).field).toBe('files[0].seq');
		expect((error as ContractError).message).toContain('files[0].seq');
	});

	it('rejects a seq with a leading zero or a sign', () => {
		for (const bad of ['0042', '-1', '+1', '1e3', '', ' 1']) {
			const page = clone(fixture.pullResponse) as Loose;
			(page.deleted as Loose[])[0]!.seq = bad;
			expect(fieldOf(() => parsePullResponse(page))).toBe('deleted[0].seq');
		}
	});

	it('requires folder to be a string or null', () => {
		const page = clone(fixture.pullResponse) as Loose;
		delete (page.files as Loose[])[1]!.folder;
		expect(fieldOf(() => parsePullResponse(page))).toBe('files[1].folder');
	});

	it('requires markdown, title and uuid to be strings', () => {
		for (const key of ['markdown', 'title', 'uuid']) {
			const page = clone(fixture.pullResponse) as Loose;
			(page.files as Loose[])[0]![key] = 7;
			expect(fieldOf(() => parsePullResponse(page))).toBe(`files[0].${key}`);
		}
	});

	it('requires the three seq lists to carry {uuid, seq}', () => {
		for (const list of ['deleted', 'missing', 'oversize']) {
			const page = clone(fixture.pullResponse) as Loose;
			(page[list] as Loose[])[0]!.uuid = 12;
			expect(fieldOf(() => parsePullResponse(page))).toBe(`${list}[0].uuid`);
		}
		const page = clone(fixture.pullResponse) as Loose;
		page.missing = 'none';
		expect(fieldOf(() => parsePullResponse(page))).toBe('missing');
	});

	it('requires hasMore and reset to be booleans', () => {
		const a = clone(fixture.pullResponse) as Loose;
		a.hasMore = 'false';
		expect(fieldOf(() => parsePullResponse(a))).toBe('hasMore');
		const b = clone(fixture.pullResponse) as Loose;
		b.reset = 0;
		expect(fieldOf(() => parsePullResponse(b))).toBe('reset');
	});

	it('requires serverTime to be an ISO timestamp', () => {
		for (const bad of ['yesterday', '2026-09-17', 1700000000, null]) {
			const page = clone(fixture.pullResponse) as Loose;
			page.serverTime = bad;
			expect(fieldOf(() => parsePullResponse(page))).toBe('serverTime');
		}
	});

	it('requires nextCursor to sit at or above every seq on the page', () => {
		const page = clone(fixture.pullResponse) as Loose;
		page.nextCursor = '1045';
		expect(fieldOf(() => parsePullResponse(page))).toBe('nextCursor');
	});

	it('returns a fresh object, not the input', () => {
		const input = clone(fixture.pullResponse);
		const parsed = parsePullResponse(input);
		expect(parsed).not.toBe(input);
		expect(parsed.files).not.toBe((input as Loose).files);
	});
});

describe('parseManifestResponse', () => {
	it('accepts the fixture sample verbatim', () => {
		const parsed = parseManifestResponse(fixture.manifestResponse);
		expect(parsed).toEqual(fixture.manifestResponse);
		expect(parsed.saves).toHaveLength(4);
	});

	it('names a malformed pair', () => {
		const m = clone(fixture.manifestResponse) as Loose;
		(m.saves as unknown[])[2] = ['0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9'];
		expect(fieldOf(() => parseManifestResponse(m))).toBe('saves[2]');
		const n = clone(fixture.manifestResponse) as Loose;
		(n.saves as unknown[])[1] = ['x', 1043];
		expect(fieldOf(() => parseManifestResponse(n))).toBe('saves[1][1]');
	});

	it('requires cursor and serverTime', () => {
		const m = clone(fixture.manifestResponse) as Loose;
		m.cursor = 1046;
		expect(fieldOf(() => parseManifestResponse(m))).toBe('cursor');
		const n = clone(fixture.manifestResponse) as Loose;
		n.serverTime = 'now';
		expect(fieldOf(() => parseManifestResponse(n))).toBe('serverTime');
	});
});

describe('compareSeq', () => {
	it('orders by length, then lexically', () => {
		expect(compareSeq('9', '10')).toBeLessThan(0);
		expect(compareSeq('10', '9')).toBeGreaterThan(0);
		expect(compareSeq('1046', '1046')).toBe(0);
		expect(compareSeq('1045', '1046')).toBeLessThan(0);
	});

	it('stays exact past Number precision', () => {
		// Number('9007199254740993') === Number('9007199254740992').
		expect(compareSeq('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
		expect(compareSeq('18446744073709551615', '18446744073709551614')).toBeGreaterThan(0);
	});
});
