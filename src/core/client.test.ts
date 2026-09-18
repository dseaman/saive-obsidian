import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RETRY_AFTER_SECONDS,
	parseMeResponse,
	RateLimitedError,
	ServerError,
	SyncClient,
	UnlinkedError,
} from './client';
import { ContractError } from './contract';
import type { HttpPort, HttpResponse } from './ports';

// The client is the plugin's only path to the network. These tests pin the
// URL and header of every request, the GET-only promise, and the mapping
// from status codes to the errors the engine reacts to.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../contracts/obsidian-sync-v1.json', import.meta.url)),
		'utf8',
	),
) as { pullResponse: unknown; manifestResponse: unknown };

interface Call {
	url: string;
	headers: Record<string, string>;
}

class FakeHttp implements HttpPort {
	calls: Call[] = [];
	next: HttpResponse = { status: 200, headers: {}, text: '{}' };

	get(url: string, headers: Record<string, string>): Promise<HttpResponse> {
		this.calls.push({ url, headers });
		return Promise.resolve(this.next);
	}

	reply(status: number, body: unknown, headers: Record<string, string> = {}): void {
		this.next = {
			status,
			headers,
			text: typeof body === 'string' ? body : JSON.stringify(body),
		};
	}
}

function client(http: FakeHttp, token: string | null = 'sv_obs_secret', baseUrl = 'https://app.saive.my/') {
	return new SyncClient({
		baseUrl,
		http,
		token: () => Promise.resolve(token),
		pluginVersion: '0.0.1',
	});
}

const HEADERS = { Authorization: 'Bearer sv_obs_secret', 'X-Saive-Plugin': '0.0.1' };

describe('SyncClient requests', () => {
	it('me() hits /api/sync/me with the bearer token and plugin version', async () => {
		const http = new FakeHttp();
		http.reply(200, { linked: true, email: 'a@b.c' });
		const me = await client(http).me();
		expect(me).toEqual({ linked: true, email: 'a@b.c' });
		expect(http.calls).toEqual([{ url: 'https://app.saive.my/api/sync/me', headers: HEADERS }]);
	});

	it('pull() encodes since, limit and comma-joined uuids', async () => {
		const http = new FakeHttp();
		http.reply(200, fixture.pullResponse);
		await client(http).pull({ since: '1042' });
		await client(http).pull({ since: '0', limit: 50 });
		await client(http).pull({
			since: '0',
			uuids: ['3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d', '7e8f9a1b-2c3d-4e5f-8789-0abcdef12345'],
		});
		expect(http.calls.map((c) => c.url)).toEqual([
			'https://app.saive.my/api/sync/pull?since=1042',
			'https://app.saive.my/api/sync/pull?since=0&limit=50',
			'https://app.saive.my/api/sync/pull?since=0&uuids=3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d,7e8f9a1b-2c3d-4e5f-8789-0abcdef12345',
		]);
		for (const call of http.calls) expect(call.headers).toEqual(HEADERS);
	});

	it('pull() refuses more than 25 uuids before any request', async () => {
		const http = new FakeHttp();
		const uuids = Array.from({ length: 26 }, () => '3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d');
		await expect(client(http).pull({ since: '0', uuids })).rejects.toThrow(RangeError);
		expect(http.calls).toEqual([]);
	});

	it('pull() runs the body through the contract guard', async () => {
		const http = new FakeHttp();
		http.reply(200, { files: [] });
		await expect(client(http).pull({ since: '0' })).rejects.toBeInstanceOf(ContractError);
		http.reply(200, 'not json');
		await expect(client(http).pull({ since: '0' })).rejects.toBeInstanceOf(ContractError);
	});

	it('file() returns the body untouched as the markdown', async () => {
		const http = new FakeHttp();
		const markdown = '---\ntitle: A\n---\n\nBody with \r\n and trailing space  \n';
		http.reply(200, markdown);
		expect(await client(http).file('3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d')).toBe(markdown);
		expect(http.calls[0]?.url).toBe(
			'https://app.saive.my/api/sync/file/3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d',
		);
	});

	it('manifest() parses the fixture sample', async () => {
		const http = new FakeHttp();
		http.reply(200, fixture.manifestResponse);
		const manifest = await client(http).manifest();
		expect(manifest.saves).toHaveLength(4);
		expect(manifest.cursor).toBe('1046');
		expect(http.calls[0]?.url).toBe('https://app.saive.my/api/sync/manifest');
	});

	it('keeps the base URL without a trailing slash', async () => {
		const http = new FakeHttp();
		http.reply(200, { linked: true });
		await client(http, 'sv_obs_secret', 'http://localhost:3000').me();
		expect(http.calls[0]?.url).toBe('http://localhost:3000/api/sync/me');
	});
});

describe('SyncClient errors', () => {
	it('throws UnlinkedError without a request when there is no token', async () => {
		const http = new FakeHttp();
		await expect(client(http, null).me()).rejects.toBeInstanceOf(UnlinkedError);
		await expect(client(http, '').manifest()).rejects.toBeInstanceOf(UnlinkedError);
		expect(http.calls).toEqual([]);
	});

	it('maps 401 to UnlinkedError', async () => {
		const http = new FakeHttp();
		http.reply(401, { error: 'unauthorized' });
		await expect(client(http).pull({ since: '0' })).rejects.toBeInstanceOf(UnlinkedError);
	});

	it('maps 429 to RateLimitedError with the Retry-After seconds', async () => {
		const http = new FakeHttp();
		http.reply(429, '', { 'Retry-After': '12' });
		const err = await client(http).pull({ since: '0' }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitedError);
		expect((err as RateLimitedError).retryAfterSeconds).toBe(12);

		http.reply(429, '', { 'retry-after': '3' });
		const lower = await client(http).manifest().catch((e: unknown) => e);
		expect((lower as RateLimitedError).retryAfterSeconds).toBe(3);

		http.reply(429, '');
		const none = await client(http).me().catch((e: unknown) => e);
		expect((none as RateLimitedError).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);

		http.reply(429, '', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
		const dated = await client(http).me().catch((e: unknown) => e);
		expect((dated as RateLimitedError).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
	});

	it('maps any other non-2xx to ServerError with the status', async () => {
		const http = new FakeHttp();
		for (const status of [404, 500, 503, 302]) {
			http.reply(status, '');
			const err = await client(http).file('3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d').catch((e: unknown) => e);
			expect(err).toBeInstanceOf(ServerError);
			expect((err as ServerError).status).toBe(status);
		}
	});

	it('lets a network failure from the port propagate as-is', async () => {
		const http: HttpPort = {
			get: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
		};
		const c = new SyncClient({
			baseUrl: 'https://app.saive.my',
			http,
			token: () => Promise.resolve('sv_obs_secret'),
			pluginVersion: '0.0.1',
		});
		await expect(c.me()).rejects.toThrow('ERR_INTERNET_DISCONNECTED');
	});
});

describe('parseMeResponse', () => {
	it('accepts an object and passes extra fields through', () => {
		expect(parseMeResponse({ linked: false, label: 'Laptop' })).toEqual({
			linked: false,
			label: 'Laptop',
		});
	});

	it('treats a missing linked field as linked', () => {
		expect(parseMeResponse({}).linked).toBe(true);
	});

	it('rejects a non-object and a non-boolean linked', () => {
		expect(() => parseMeResponse('ok')).toThrow(ContractError);
		expect(() => parseMeResponse([])).toThrow(ContractError);
		expect(() => parseMeResponse({ linked: 'yes' })).toThrow(ContractError);
	});
});
