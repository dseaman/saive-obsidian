// Types and runtime guards for the obsidian-sync v1 wire contract
// (contracts/obsidian-sync-v1.json). Everything the plugin reads from
// app.saive.my passes through parsePullResponse or parseManifestResponse
// first, so a contract drift surfaces as one ContractError naming the field
// instead of an undefined deep inside the planner.
//
// seq and cursor values are decimal strings: change_seq is a Postgres
// bigint, and Number would silently round anything past 2^53. Compare them
// with compareSeq, never with < on numbers.

export interface PullFile {
	uuid: string;
	seq: string;
	folder: string | null;
	title: string;
	markdown: string;
}

export interface SeqRef {
	uuid: string;
	seq: string;
}

export interface PullResponse {
	files: PullFile[];
	deleted: SeqRef[];
	missing: SeqRef[];
	oversize: SeqRef[];
	nextCursor: string;
	hasMore: boolean;
	reset: boolean;
	serverTime: string;
}

export interface ManifestResponse {
	saves: [uuid: string, seq: string][];
	cursor: string;
	serverTime: string;
}

export class ContractError extends Error {
	readonly field: string;

	constructor(field: string, expected: string) {
		super(`Sync contract: ${field} ${expected}`);
		this.name = 'ContractError';
		this.field = field;
	}
}

/**
 * Order two seq or cursor strings. Both must be canonical decimal strings
 * (no sign, no leading zero), which the guards enforce; then a longer string
 * is the larger number and equal lengths compare lexically.
 */
export function compareSeq(a: string, b: string): number {
	if (a.length !== b.length) return a.length < b.length ? -1 : 1;
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

const SEQ = /^(?:0|[1-9][0-9]*)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ContractError(field, 'must be an object');
	return value;
}

function list(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new ContractError(field, 'must be an array');
	return value;
}

function str(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new ContractError(field, 'must be a string');
	return value;
}

function seq(value: unknown, field: string): string {
	const s = str(value, field);
	if (!SEQ.test(s)) throw new ContractError(field, 'must be a decimal string');
	return s;
}

function bool(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new ContractError(field, 'must be a boolean');
	return value;
}

function isoTime(value: unknown, field: string): string {
	const s = str(value, field);
	if (!ISO_TIME.test(s) || Number.isNaN(Date.parse(s))) {
		throw new ContractError(field, 'must be an ISO 8601 timestamp');
	}
	return s;
}

function seqRefs(value: unknown, field: string): SeqRef[] {
	return list(value, field).map((item, i) => {
		const row = record(item, `${field}[${i}]`);
		return {
			uuid: str(row.uuid, `${field}[${i}].uuid`),
			seq: seq(row.seq, `${field}[${i}].seq`),
		};
	});
}

function pullFile(value: unknown, field: string): PullFile {
	const row = record(value, field);
	const folder = row.folder;
	if (folder !== null && typeof folder !== 'string') {
		throw new ContractError(`${field}.folder`, 'must be a string or null');
	}
	return {
		uuid: str(row.uuid, `${field}.uuid`),
		seq: seq(row.seq, `${field}.seq`),
		folder,
		title: str(row.title, `${field}.title`),
		markdown: str(row.markdown, `${field}.markdown`),
	};
}

export function parsePullResponse(value: unknown): PullResponse {
	const row = record(value, '$');
	const page: PullResponse = {
		files: list(row.files, 'files').map((f, i) => pullFile(f, `files[${i}]`)),
		deleted: seqRefs(row.deleted, 'deleted'),
		missing: seqRefs(row.missing, 'missing'),
		oversize: seqRefs(row.oversize, 'oversize'),
		nextCursor: seq(row.nextCursor, 'nextCursor'),
		hasMore: bool(row.hasMore, 'hasMore'),
		reset: bool(row.reset, 'reset'),
		serverTime: isoTime(row.serverTime, 'serverTime'),
	};
	// The contract promises nextCursor at or above every seq on the page.
	// The planner records seqs into state and trusts that promise, so check
	// it here where the whole page is in view.
	for (const group of [page.files, page.deleted, page.missing, page.oversize]) {
		for (const item of group) {
			if (compareSeq(item.seq, page.nextCursor) > 0) {
				throw new ContractError('nextCursor', `must be at or above seq ${item.seq}`);
			}
		}
	}
	return page;
}

export function parseManifestResponse(value: unknown): ManifestResponse {
	const row = record(value, '$');
	const saves = list(row.saves, 'saves').map((item, i): [string, string] => {
		if (!Array.isArray(item) || item.length !== 2) {
			throw new ContractError(`saves[${i}]`, 'must be a [uuid, seq] pair');
		}
		return [str(item[0], `saves[${i}][0]`), seq(item[1], `saves[${i}][1]`)];
	});
	return {
		saves,
		cursor: seq(row.cursor, 'cursor'),
		serverTime: isoTime(row.serverTime, 'serverTime'),
	};
}
