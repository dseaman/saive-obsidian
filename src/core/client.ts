// The HTTP client for app.saive.my's /api/sync routes. Every method is a
// GET through the injected HttpPort (Obsidian's requestUrl in production, a
// recording fake in tests), sends the bearer token and the plugin version,
// and runs the body through the contract guards. Non-2xx statuses become
// typed errors so the engine can tell "the user unlinked this device" from
// "slow down" from "the server broke".

import {
	ContractError,
	parseManifestResponse,
	parsePullResponse,
	type ManifestResponse,
	type PullResponse,
} from './contract';
import type { HttpPort, HttpResponse } from './ports';

/** The token is missing, revoked or expired: the device needs linking again. */
export class UnlinkedError extends Error {
	constructor() {
		super('This device is not linked to a Saive account');
		this.name = 'UnlinkedError';
	}
}

/** 429 from the server. `retryAfterSeconds` comes from the Retry-After header. */
export class RateLimitedError extends Error {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super(`Saive asked the plugin to wait ${retryAfterSeconds} seconds`);
		this.name = 'RateLimitedError';
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** Any other non-2xx status. */
export class ServerError extends Error {
	readonly status: number;

	constructor(status: number, route: string) {
		super(`Saive returned ${status} for ${route}`);
		this.name = 'ServerError';
		this.status = status;
	}
}

export interface MeResponse {
	linked: boolean;
	[key: string]: unknown;
}

/**
 * /api/sync/me is not in the contract fixture, so this guard asks for an
 * object and, when `linked` is present, a boolean. A 200 with no `linked`
 * field counts as linked: the route answers 401 for a token it rejects.
 */
export function parseMeResponse(value: unknown): MeResponse {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ContractError('$', 'must be an object');
	}
	const row = value as Record<string, unknown>;
	if (row.linked !== undefined && typeof row.linked !== 'boolean') {
		throw new ContractError('linked', 'must be a boolean');
	}
	return { ...row, linked: row.linked === undefined ? true : row.linked };
}

export interface PullParams {
	since: string;
	limit?: number;
	/** Reconcile: fetch these saves (at most 25) regardless of `since`. */
	uuids?: string[];
}

export interface SyncClientOptions {
	/** e.g. "https://app.saive.my", with or without a trailing slash. */
	baseUrl: string;
	http: HttpPort;
	/** Resolves the sync token, or null when the device is not linked. */
	token: () => Promise<string | null>;
	pluginVersion: string;
}

export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Reconcile pulls carry at most this many uuids per request. */
export const MAX_UUIDS_PER_PULL = 25;

function header(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

function retryAfter(headers: Record<string, string>): number {
	const raw = header(headers, 'retry-after');
	const seconds = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ContractError('$', 'must be JSON');
	}
}

export class SyncClient {
	private readonly baseUrl: string;
	private readonly http: HttpPort;
	private readonly token: () => Promise<string | null>;
	private readonly pluginVersion: string;

	constructor(opts: SyncClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this.http = opts.http;
		this.token = opts.token;
		this.pluginVersion = opts.pluginVersion;
	}

	async me(): Promise<MeResponse> {
		const res = await this.get('/api/sync/me');
		return parseMeResponse(parseJson(res.text));
	}

	async pull(params: PullParams): Promise<PullResponse> {
		if (params.uuids !== undefined && params.uuids.length > MAX_UUIDS_PER_PULL) {
			throw new RangeError(`pull accepts at most ${MAX_UUIDS_PER_PULL} uuids`);
		}
		const query: string[] = [`since=${encodeURIComponent(params.since)}`];
		if (params.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
		if (params.uuids !== undefined && params.uuids.length > 0) {
			query.push(`uuids=${params.uuids.map((u) => encodeURIComponent(u)).join(',')}`);
		}
		const res = await this.get(`/api/sync/pull?${query.join('&')}`);
		return parsePullResponse(parseJson(res.text));
	}

	/** The markdown bytes of one save, for an `oversize` entry. */
	async file(uuid: string): Promise<string> {
		const res = await this.get(`/api/sync/file/${encodeURIComponent(uuid)}`);
		return res.text;
	}

	async manifest(): Promise<ManifestResponse> {
		const res = await this.get('/api/sync/manifest');
		return parseManifestResponse(parseJson(res.text));
	}

	private async get(route: string): Promise<HttpResponse> {
		const token = await this.token();
		if (token === null || token === '') throw new UnlinkedError();
		const res = await this.http.get(`${this.baseUrl}${route}`, {
			Authorization: `Bearer ${token}`,
			'X-Saive-Plugin': this.pluginVersion,
		});
		if (res.status === 401) throw new UnlinkedError();
		if (res.status === 429) throw new RateLimitedError(retryAfter(res.headers));
		if (res.status < 200 || res.status >= 300) throw new ServerError(res.status, route);
		return res;
	}
}
