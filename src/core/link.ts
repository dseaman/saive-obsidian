// The link flow's pure half. The plugin generates the secret; only its
// SHA-256 hash travels: in the consent page URL, and later as the lookup
// key on the server. The six-character code is derived from the hash on
// both ends (link-code.ts), so the user can see whether the page that
// opened is the page this plugin asked for.
//
// pollUntilLinked is the "are we linked yet?" loop. The consent page never
// calls back into Obsidian (obsidian://saive?linked=1 only refocuses the
// app), so the plugin asks /api/sync/me until the 401s turn into a 200.

import { RateLimitedError, UnlinkedError } from './client';
import type { MeResponse } from './client';
import { sha256Hex } from './hash';
import { linkCode } from './link-code';

export const BASE_URL = 'https://app.saive.my';
export const SIGNUP_URL = 'https://saive.my/?utm_source=obsidian-plugin';
export const DOCS_URL = 'https://github.com/dseaman/saive-obsidian#how-syncing-works';
export const PRIVACY_URL = 'https://saive.my/privacy';
/** The app.secretStorage id that holds the sync token. Never a data.json key. */
export const SECRET_KEY = 'saive-sync-token';

const SECRET_PREFIX = 'sv_obs_';
const SECRET_BYTES = 32;

export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 600_000;
/** Consecutive failures (other than 401 and 429) before the poll gives up. */
export const MAX_POLL_FAILURES = 3;

// btoa exists on Obsidian desktop and mobile; no Buffer needed.
function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh sync token: `sv_obs_` plus base64url of 32 random bytes. The
 * caller supplies the randomness (crypto.getRandomValues in the plugin) so
 * the shape can be tested with fixed bytes.
 */
export function generateSecret(random: (n: number) => Uint8Array): string {
	const bytes = random(SECRET_BYTES);
	if (bytes.length !== SECRET_BYTES) {
		throw new RangeError(`generateSecret needs ${SECRET_BYTES} random bytes, got ${bytes.length}`);
	}
	return `${SECRET_PREFIX}${base64url(bytes)}`;
}

export interface StartLinkOptions {
	secret: string;
	/** Shown on the consent page and in Settings on the web; the server sanitizes it. */
	vaultName: string;
	baseUrl: string;
}

export interface LinkStart {
	/** SHA-256 hex of the secret: the only form the server ever sees. */
	hash: string;
	/** Six characters the user compares with the consent page. */
	code: string;
	/** The consent page to open in the browser. */
	url: string;
}

export async function startLink(opts: StartLinkOptions): Promise<LinkStart> {
	const hash = await sha256Hex(opts.secret);
	const base = opts.baseUrl.replace(/\/+$/, '');
	return {
		hash,
		code: linkCode(hash),
		url: `${base}/obsidian/connect?h=${hash}&label=${encodeURIComponent(opts.vaultName)}`,
	};
}

export type PollResult = 'linked' | 'timeout' | 'cancelled';

export interface PollOptions {
	intervalMs?: number;
	timeoutMs?: number;
	/** Resolves after `ms`, or sooner when the caller wants an early poll. */
	sleep: (ms: number) => Promise<void>;
	isCancelled: () => boolean;
	/** Milliseconds on a monotonic-enough clock; Date.now by default. */
	now?: () => number;
}

/**
 * Polls `client.me()` until the server accepts the token. A 401 means the
 * user has not approved yet; a 429 waits its Retry-After. Any other error
 * counts toward a budget of MAX_POLL_FAILURES in a row, after which it
 * propagates: a server that keeps breaking should not be hidden behind a
 * modal that looks like it is waiting.
 */
export interface MeClient {
	me(): Promise<MeResponse>;
}

export async function pollUntilLinked(client: MeClient, opts: PollOptions): Promise<PollResult> {
	const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
	const now = opts.now ?? (() => Date.now());
	const started = now();
	let failures = 0;

	for (;;) {
		if (opts.isCancelled()) return 'cancelled';
		let waitMs = intervalMs;
		try {
			const me = await client.me();
			// A cancel during the request wins: the caller closed the modal
			// and must not see a link it walked away from.
			if (me.linked) return opts.isCancelled() ? 'cancelled' : 'linked';
			failures = 0;
		} catch (err) {
			if (err instanceof UnlinkedError || err instanceof RateLimitedError) {
				// Both mean the server answered as expected; neither is a failure.
				failures = 0;
				if (err instanceof RateLimitedError) waitMs = err.retryAfterSeconds * 1000;
			} else {
				failures += 1;
				if (failures >= MAX_POLL_FAILURES) throw err;
			}
		}
		if (opts.isCancelled()) return 'cancelled';
		if (now() - started + waitMs > timeoutMs) return 'timeout';
		await opts.sleep(waitMs);
	}
}

export interface LinkFlowDeps {
	/** The candidate secret, held in memory until the server accepts it. */
	secret: string;
	/** A client whose token getter returns the candidate, not the stored secret. */
	client: MeClient;
	/** The secret store; called once, after 'linked', never before. */
	store: { set(secret: string): Promise<void> };
	poll: PollOptions;
}

/**
 * The whole link, from the first poll to the stored secret. The store runs
 * only on 'linked': a cancel, a timeout, an error or an unload leaves
 * whatever secret the device held before untouched, so a linked user who
 * starts a second link and walks away stays linked.
 */
export async function runLinkFlow(deps: LinkFlowDeps): Promise<PollResult> {
	const result = await pollUntilLinked(deps.client, deps.poll);
	if (result === 'linked') await deps.store.set(deps.secret);
	return result;
}
