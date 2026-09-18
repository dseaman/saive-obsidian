import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// contracts/obsidian-sync-v1.json is a copy of the wire contract the Saive
// server asserts against (docs/contracts/obsidian-sync-v1.json in the Saive
// repo). The server and this plugin share no code, so both sides pin one
// frozen file. Change it upstream first, bump `version`, then copy it here.
//
// This suite proves the copy is intact. The plugin's own sha256 and link-code
// ports assert against the same vectors once they exist.

interface ContractFixture {
	contract: string;
	version: number;
	tokenHashVector: { secret: string; sha256Hex: string };
	linkCodeVector: { sha256Hex: string; code: string };
	pullResponse: {
		files: { folder: string | null; markdown: string }[];
		oversize: { uuid: string; seq: string; folder?: string | null; title?: string }[];
	};
}

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../contracts/obsidian-sync-v1.json', import.meta.url),
		),
		'utf8',
	),
) as ContractFixture;

describe('sync contract fixture', () => {
	it('is version 1.1 of the obsidian-sync contract', () => {
		expect(fixture.contract).toBe('obsidian-sync');
		expect(fixture.version).toBe(1.1);
	});

	it('token hash vector is a true sha256', () => {
		const { secret, sha256Hex } = fixture.tokenHashVector;
		expect(secret.startsWith('sv_obs_')).toBe(true);
		expect(createHash('sha256').update(secret).digest('hex')).toBe(sha256Hex);
	});

	it('link code vector derives from the same hash', () => {
		expect(fixture.linkCodeVector.sha256Hex).toBe(
			fixture.tokenHashVector.sha256Hex,
		);
		expect(fixture.linkCodeVector.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
	});

	it('sample pull keeps the unfiled-save case and the awkward bytes', () => {
		const files = fixture.pullResponse.files;
		expect(files.some((f) => f.folder === null)).toBe(true);
		expect(files.some((f) => f.markdown.includes('\r\n'))).toBe(true);
	});

	// What 1.1 added. /api/sync/file returns bare markdown with no folder and
	// no title, so an oversize save the vault has never seen has nowhere to go
	// unless the pull page names its place. Every sample entry carries both.
	it('sample oversize entries carry the folder and title a new save needs', () => {
		const oversize = fixture.pullResponse.oversize;
		expect(oversize.length).toBeGreaterThan(0);
		for (const entry of oversize) {
			expect(entry.folder === null || typeof entry.folder === 'string').toBe(true);
			expect(typeof entry.title).toBe('string');
			expect(entry.title).not.toBe('');
		}
	});
});
