// The six-character check code shown on both ends of the link flow: the
// plugin shows it for the token hash it generated, and the consent page at
// app.saive.my shows it for the hash it received. If a third party swapped
// the hash on the way (device-flow phishing), the two differ.
//
// A hand port of extensionLinkCode in the Saive monorepo
// (packages/core/src/extension-link.ts). The repos share no code, so
// link-code.test.ts pins this port to the frozen fixture vector plus vectors
// computed from the monorepo function. One drifted character would train
// every user to click through the one check that protects their library.

// Crockford-style alphabet: no I, L, O or U. 32 symbols is 5 bits per
// character, so the bit slicing below needs no modulo bias correction.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters shown to the user. 6 x 5 bits = 30 bits of the hash. */
export const LINK_CODE_LENGTH = 6;

/**
 * Derive the check code from the SHA-256 hex digest of the token secret.
 * Returns an empty string for anything that is not a 64-character hex
 * digest, so a malformed value shows as "no code" rather than a confident
 * wrong one.
 */
export function linkCode(sha256Hex: string): string {
	const hex = sha256Hex.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(hex)) return '';

	// Read 30 bits out of the first 8 hex characters (32 bits) and emit them
	// five at a time, most-significant first.
	const bits = Number.parseInt(hex.slice(0, 8), 16);
	let code = '';
	for (let i = 0; i < LINK_CODE_LENGTH; i++) {
		const shift = 32 - 5 * (i + 1);
		code += ALPHABET.charAt((bits >>> shift) & 0b11111);
	}
	return code;
}
