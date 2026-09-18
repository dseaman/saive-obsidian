import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINK_CODE_LENGTH, linkCode } from './link-code';

// The consent page (Saive monorepo, packages/core/src/extension-link.ts)
// and this plugin must show the same six characters for the same token
// hash. The two repos share no code, so the plugin's port is proven against
// the frozen fixture vector plus vectors computed from the monorepo function
// on 2026-09-17.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../../contracts/obsidian-sync-v1.json', import.meta.url),
		),
		'utf8',
	),
) as { linkCodeVector: { sha256Hex: string; code: string } };

describe('linkCode', () => {
	it('matches the frozen fixture vector', () => {
		const { sha256Hex, code } = fixture.linkCodeVector;
		expect(linkCode(sha256Hex)).toBe(code);
		expect(code).toHaveLength(LINK_CODE_LENGTH);
	});

	it('matches vectors computed from the monorepo implementation', () => {
		// EXTENSION_LINK_HASH_VECTOR.sha256Hex through extensionLinkCode.
		expect(
			linkCode('a3697ac78615699b38ee2d372ee5eba9fec666acd7b85f2b171bda090c336d40'),
		).toBe('MDMQNH');
		expect(linkCode('0'.repeat(64))).toBe('000000');
		expect(linkCode('f'.repeat(64))).toBe('ZZZZZZ');
	});

	it('tolerates uppercase hex and surrounding whitespace', () => {
		const { sha256Hex, code } = fixture.linkCodeVector;
		expect(linkCode(`  ${sha256Hex.toUpperCase()} `)).toBe(code);
	});

	it('returns an empty string for anything but a 64-char hex digest', () => {
		expect(linkCode('')).toBe('');
		expect(linkCode('abc')).toBe('');
		expect(linkCode('g'.repeat(64))).toBe('');
		expect(linkCode('0x' + '0'.repeat(62))).toBe('');
		expect(linkCode('0'.repeat(63))).toBe('');
	});

	it('never emits I, L, O or U', () => {
		for (let i = 0; i < 64; i++) {
			const hex = i.toString(16).padStart(2, '0').repeat(32);
			expect(linkCode(hex)).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
		}
	});
});
