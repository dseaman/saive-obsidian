import { describe, expect, it } from 'vitest';
import { RateLimitedError, ServerError, UnlinkedError } from './client';
import type { MeResponse } from './client';
import { ContractError } from './contract';
import { sha256Hex } from './hash';
import {
	BASE_URL,
	DOCS_URL,
	generateSecret,
	MAX_POLL_FAILURES,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS,
	pollUntilLinked,
	runLinkFlow,
	SECRET_KEY,
	SIGNUP_URL,
	startLink,
} from './link';
import type { MeClient, PollOptions } from './link';
import { linkCode } from './link-code';

// The link flow's pure half. generateSecret and startLink pin the token
// shape the server accepts (sync-token.ts in the monorepo: `sv_obs_` plus
// base64url of 32 bytes, hash alone on the wire) and the consent URL.
// pollUntilLinked is driven here with a fake client and a fake clock, so
// the interval, the timeout, cancellation and the failure budget are all
// checked without a timer.

function bytes(n: number, fill = 0): Uint8Array {
	return new Uint8Array(n).fill(fill);
}

describe('generateSecret', () => {
	it('prefixes sv_obs_ and encodes 32 bytes as 43 base64url chars, no padding', () => {
		const secret = generateSecret((n) => bytes(n, 0xff));
		expect(secret.startsWith('sv_obs_')).toBe(true);
		const body = secret.slice('sv_obs_'.length);
		expect(body).toHaveLength(43);
		expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
		// 256 one-bits: 42 full sextets of 63, then 1111 padded to 111100.
		expect(body).toBe('_'.repeat(42) + '8');
	});

	it('asks the random source for exactly 32 bytes', () => {
		const asked: number[] = [];
		generateSecret((n) => {
			asked.push(n);
			return bytes(n);
		});
		expect(asked).toEqual([32]);
	});

	it('uses the url-safe alphabet for bytes that base64 would pad or slash', () => {
		// 0xfb 0xff => "+/8" in base64; base64url writes "-_8".
		const secret = generateSecret((n) => {
			const out = bytes(n);
			out[0] = 0xfb;
			out[1] = 0xff;
			return out;
		});
		expect(secret.slice('sv_obs_'.length, 'sv_obs_'.length + 3)).toBe('-_8');
		expect(secret).not.toMatch(/[+/=]/);
	});

	it('rejects a random source that returns the wrong length', () => {
		expect(() => generateSecret(() => bytes(16))).toThrow(RangeError);
	});
});

describe('startLink', () => {
	it('derives the hash and code from the secret and never puts the secret in the url', async () => {
		const secret = generateSecret((n) => bytes(n, 7));
		const link = await startLink({ secret, vaultName: 'Notes', baseUrl: BASE_URL });
		expect(link.hash).toBe(await sha256Hex(secret));
		expect(link.code).toBe(linkCode(link.hash));
		expect(link.code).toHaveLength(6);
		expect(link.url).toBe(`https://app.saive.my/obsidian/connect?h=${link.hash}&label=Notes`);
		expect(link.url).not.toContain(secret.slice('sv_obs_'.length, 20));
	});

	it('encodes a vault name with spaces and unicode', async () => {
		const secret = generateSecret((n) => bytes(n, 1));
		const link = await startLink({ secret, vaultName: 'Dan été メモ & co', baseUrl: BASE_URL });
		expect(link.url.endsWith('&label=Dan%20%C3%A9t%C3%A9%20%E3%83%A1%E3%83%A2%20%26%20co')).toBe(true);
	});

	it('tolerates a trailing slash on the base url', async () => {
		const secret = generateSecret((n) => bytes(n, 2));
		const link = await startLink({ secret, vaultName: 'v', baseUrl: 'https://app.saive.my/' });
		expect(link.url.startsWith('https://app.saive.my/obsidian/connect?h=')).toBe(true);
	});
});

describe('constants', () => {
	it('point at the production host and the tagged marketing pages', () => {
		expect(BASE_URL).toBe('https://app.saive.my');
		expect(SIGNUP_URL).toBe('https://saive.my/?utm_source=obsidian-plugin');
		expect(DOCS_URL).toBe('https://saive.my/docs/obsidian?utm_source=obsidian-plugin');
		expect(SECRET_KEY).toBe('saive-sync-token');
	});
});

// A scripted /me: each entry is one call's outcome.
type Step = { ok: MeResponse } | { throw: Error };

class FakeClient {
	calls = 0;
	constructor(private readonly steps: Step[]) {}

	me(): Promise<MeResponse> {
		const step = this.steps[this.calls] ?? { throw: new UnlinkedError() };
		this.calls += 1;
		return 'ok' in step ? Promise.resolve(step.ok) : Promise.reject(step.throw);
	}
}

class FakeClock {
	now = 0;
	sleeps: number[] = [];
	cancelled = false;

	sleep = (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.now += ms;
		return Promise.resolve();
	};

	isCancelled = (): boolean => this.cancelled;
}

const unlinked = (): Step => ({ throw: new UnlinkedError() });
const linked = (): Step => ({ ok: { linked: true } });

function poll(client: FakeClient, clock: FakeClock, extra: Partial<PollOptions> = {}) {
	return pollUntilLinked(client, {
		sleep: clock.sleep,
		isCancelled: clock.isCancelled,
		now: () => clock.now,
		...extra,
	});
}

describe('pollUntilLinked', () => {
	it('returns linked on the first 200 without sleeping', async () => {
		const client = new FakeClient([linked()]);
		const clock = new FakeClock();
		await expect(poll(client, clock)).resolves.toBe('linked');
		expect(client.calls).toBe(1);
		expect(clock.sleeps).toEqual([]);
	});

	it('keeps polling through 401s at the interval until a 200', async () => {
		const client = new FakeClient([unlinked(), unlinked(), linked()]);
		const clock = new FakeClock();
		await expect(poll(client, clock)).resolves.toBe('linked');
		expect(client.calls).toBe(3);
		expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
	});

	it('treats a 200 with linked:false as not yet linked', async () => {
		const client = new FakeClient([{ ok: { linked: false } }, linked()]);
		const clock = new FakeClock();
		await expect(poll(client, clock)).resolves.toBe('linked');
		expect(client.calls).toBe(2);
	});

	it('times out after timeoutMs of waiting', async () => {
		const client = new FakeClient([]);
		const clock = new FakeClock();
		await expect(poll(client, clock, { intervalMs: 1000, timeoutMs: 3500 })).resolves.toBe('timeout');
		// Polls at 0, 1000, 2000, 3000; the next wait would pass 3500.
		expect(client.calls).toBe(4);
		expect(clock.sleeps).toEqual([1000, 1000, 1000]);
	});

	it('uses the ten-minute default timeout', async () => {
		const client = new FakeClient([]);
		const clock = new FakeClock();
		await expect(poll(client, clock)).resolves.toBe('timeout');
		expect(POLL_TIMEOUT_MS).toBe(600_000);
		expect(clock.now).toBeLessThanOrEqual(POLL_TIMEOUT_MS);
		expect(clock.now + POLL_INTERVAL_MS).toBeGreaterThan(POLL_TIMEOUT_MS);
	});

	it('returns cancelled as soon as the caller cancels, without another request', async () => {
		const client = new FakeClient([unlinked(), unlinked()]);
		const clock = new FakeClock();
		clock.sleep = (ms) => {
			clock.sleeps.push(ms);
			clock.now += ms;
			clock.cancelled = true;
			return Promise.resolve();
		};
		await expect(poll(client, clock)).resolves.toBe('cancelled');
		expect(client.calls).toBe(1);
	});

	it('returns cancelled before the first request when already cancelled', async () => {
		const client = new FakeClient([linked()]);
		const clock = new FakeClock();
		clock.cancelled = true;
		await expect(poll(client, clock)).resolves.toBe('cancelled');
		expect(client.calls).toBe(0);
	});

	it('waits out a 429 for its Retry-After instead of the interval', async () => {
		const client = new FakeClient([{ throw: new RateLimitedError(17) }, linked()]);
		const clock = new FakeClock();
		await expect(poll(client, clock)).resolves.toBe('linked');
		expect(clock.sleeps).toEqual([17_000]);
	});

	it('tolerates two transient failures in a row and throws on the third', async () => {
		const boom = () => ({ throw: new ServerError(503, '/api/sync/me') });
		const twice = new FakeClient([boom(), boom(), linked()]);
		await expect(poll(twice, new FakeClock())).resolves.toBe('linked');
		expect(twice.calls).toBe(3);

		const thrice = new FakeClient([boom(), boom(), boom(), linked()]);
		await expect(poll(thrice, new FakeClock())).rejects.toBeInstanceOf(ServerError);
		expect(thrice.calls).toBe(MAX_POLL_FAILURES);
	});

	it('resets the failure count after a 401 or a 429, both expected answers', async () => {
		const boom = () => ({ throw: new ContractError('$', 'must be JSON') });
		const after401 = new FakeClient([boom(), boom(), unlinked(), boom(), boom(), linked()]);
		await expect(poll(after401, new FakeClock())).resolves.toBe('linked');
		expect(after401.calls).toBe(6);

		const after429 = new FakeClient([
			boom(),
			boom(),
			{ throw: new RateLimitedError(1) },
			boom(),
			boom(),
			linked(),
		]);
		await expect(poll(after429, new FakeClock())).resolves.toBe('linked');
		expect(after429.calls).toBe(6);
	});

	it('returns cancelled when the cancel lands while a request that says linked is in flight', async () => {
		const clock = new FakeClock();
		const client: MeClient = {
			me: () => {
				clock.cancelled = true;
				return Promise.resolve({ linked: true });
			},
		};
		await expect(
			pollUntilLinked(client, { sleep: clock.sleep, isCancelled: clock.isCancelled, now: () => clock.now }),
		).resolves.toBe('cancelled');
	});
});

// The store must run after the server said yes and never otherwise. A
// secret written before approval would replace a working one on a device
// that was already linked, and every sync after a cancel would abort.
describe('runLinkFlow', () => {
	class FakeStore {
		stored: string[] = [];
		storedAfterCalls: number[] = [];
		constructor(private readonly client: FakeClient) {}
		set(secret: string): Promise<void> {
			this.stored.push(secret);
			this.storedAfterCalls.push(this.client.calls);
			return Promise.resolve();
		}
	}

	function flow(client: FakeClient, clock: FakeClock, poll: Partial<PollOptions> = {}) {
		const store = new FakeStore(client);
		const done = runLinkFlow({
			secret: 'sv_obs_candidate',
			client,
			store,
			poll: { sleep: clock.sleep, isCancelled: clock.isCancelled, now: () => clock.now, ...poll },
		});
		return { store, done };
	}

	it('stores the candidate once, after the poll returned linked', async () => {
		const client = new FakeClient([unlinked(), linked()]);
		const { store, done } = flow(client, new FakeClock());
		await expect(done).resolves.toBe('linked');
		expect(store.stored).toEqual(['sv_obs_candidate']);
		expect(store.storedAfterCalls).toEqual([2]);
	});

	it('stores nothing on cancel', async () => {
		const clock = new FakeClock();
		clock.cancelled = true;
		const { store, done } = flow(new FakeClient([linked()]), clock);
		await expect(done).resolves.toBe('cancelled');
		expect(store.stored).toEqual([]);
	});

	it('stores nothing on timeout', async () => {
		const { store, done } = flow(new FakeClient([]), new FakeClock(), { intervalMs: 1000, timeoutMs: 2500 });
		await expect(done).resolves.toBe('timeout');
		expect(store.stored).toEqual([]);
	});

	it('stores nothing when the poll throws', async () => {
		const boom = () => ({ throw: new ServerError(500, '/api/sync/me') });
		const { store, done } = flow(new FakeClient([boom(), boom(), boom()]), new FakeClock());
		await expect(done).rejects.toBeInstanceOf(ServerError);
		expect(store.stored).toEqual([]);
	});
});
