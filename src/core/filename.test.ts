import { describe, expect, it } from 'vitest';
import { buildPath, pathMatches, sanitizeTitle, withSuffix } from './filename';

// Filenames must survive three desktop OSes, Obsidian's own link syntax and
// a case-insensitive disk, and the same title must land at the same path on
// every device that syncs the same library. Each rule gets one case.

const uuid = '3a4b5c6d-7e8f-4a1b-9c2d-1e2f3a4b5c6d';
const uuid8 = '3a4b5c6d';

describe('sanitizeTitle', () => {
	it('replaces the characters the OSes reject and collapses the gaps', () => {
		expect(sanitizeTitle('a\\b/c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
		expect(sanitizeTitle('one  \t two')).toBe('one two');
	});

	it('replaces the characters that break Obsidian links', () => {
		expect(sanitizeTitle('[[Wiki]] #tag ^block')).toBe('Wiki tag block');
	});

	it('drops control characters', () => {
		expect(sanitizeTitle('tab\there\u0000null\u007f')).toBe('tab here null');
	});

	it('strips leading and trailing dots and spaces', () => {
		expect(sanitizeTitle('  ..hidden.. ')).toBe('hidden');
		expect(sanitizeTitle('...')).toBe('');
		expect(sanitizeTitle('v1.2.3')).toBe('v1.2.3');
	});

	it('normalizes to NFC so macOS and Windows agree on the bytes', () => {
		expect(sanitizeTitle('Cafe\u0301')).toBe('Caf\u00e9');
	});

	it('caps at 120 code points without splitting a surrogate pair', () => {
		const long = 'a'.repeat(119) + '\u{1F4DA}\u{1F4DA}';
		const out = sanitizeTitle(long);
		expect(Array.from(out)).toHaveLength(120);
		expect(out.endsWith('\u{1F4DA}')).toBe(true);
		expect(sanitizeTitle('b'.repeat(300))).toBe('b'.repeat(120));
	});

	it('re-strips a trailing space or dot left by the cut', () => {
		expect(sanitizeTitle('c'.repeat(119) + ' d')).toBe('c'.repeat(119));
		expect(sanitizeTitle('c'.repeat(119) + '.d')).toBe('c'.repeat(119));
	});
});

describe('buildPath', () => {
	it('places a filed save under root/folder and an unfiled save under root', () => {
		expect(buildPath('Saive', 'Recipes', 'Example save', uuid, new Set())).toBe(
			'Saive/Recipes/Example save.md',
		);
		expect(buildPath('Saive', null, 'Unfiled save', uuid, new Set())).toBe(
			'Saive/Unfiled save.md',
		);
	});

	it('sanitizes the folder with the same rules', () => {
		expect(buildPath('Saive', 'Rec/ipes: 2026', 'x', uuid, new Set())).toBe(
			'Saive/Rec ipes 2026/x.md',
		);
	});

	it('tolerates a root with stray slashes', () => {
		expect(buildPath('/Saive/', null, 'x', uuid, new Set())).toBe('Saive/x.md');
	});

	it('falls back to the first 8 uuid characters for an empty title', () => {
		expect(buildPath('Saive', null, '???', uuid, new Set())).toBe(
			`Saive/${uuid8}.md`,
		);
	});

	it('drops an empty folder to the root', () => {
		expect(buildPath('Saive', '***', 'x', uuid, new Set())).toBe('Saive/x.md');
	});

	const reservedBases = [
		'CON', 'PRN', 'AUX', 'NUL',
		...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
		...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
	];
	const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

	it('tags Windows reserved names before the first dot', () => {
		for (const name of ['CON', 'con', 'NUL', 'COM1', 'lpt9']) {
			expect(buildPath('Saive', null, name, uuid, new Set())).toBe(
				`Saive/${name} (${uuid8}).md`,
			);
		}
		expect(buildPath('Saive', null, 'con.txt', uuid, new Set())).toBe(
			`Saive/con (${uuid8}).txt.md`,
		);
		expect(buildPath('Saive', null, 'CONSOLE', uuid, new Set())).toBe(
			'Saive/CONSOLE.md',
		);
		expect(buildPath('Saive', null, 'COM0', uuid, new Set())).toBe('Saive/COM0.md');
	});

	it('leaves no reserved base name in any final basename', () => {
		for (const base of reservedBases) {
			for (const title of [base, base.toLowerCase(), `${base}.txt`, `${base}.tar.gz`]) {
				const path = buildPath('Saive', null, title, uuid, new Set());
				const basename = path.slice(path.lastIndexOf('/') + 1);
				const beforeDot = basename.slice(0, basename.indexOf('.'));
				expect(beforeDot, path).not.toMatch(reserved);
			}
		}
	});

	it('tags a reserved folder name without any uuid, so saves share it', () => {
		const other = '7e8f9a1b-2c3d-4e5f-8789-0abcdef12345';
		expect(buildPath('Saive', 'NUL', 'x', uuid, new Set())).toBe('Saive/NUL (folder)/x.md');
		expect(buildPath('Saive', 'NUL', 'y', other, new Set())).toBe('Saive/NUL (folder)/y.md');
		expect(buildPath('Saive', 'com1.old', 'x', uuid, new Set())).toBe(
			'Saive/com1 (folder).old/x.md',
		);
	});

	it('never lets a hostile uuid add path segments', () => {
		const hostile = [
			'../../x',
			'..',
			'a/b/c/d/e/f/g/h',
			'../../abcdef1234-x/..',
			'\\..\\x',
			'. . .',
			'/',
			'',
		];
		for (const bad of hostile) {
			for (const title of ['', '???', 'x']) {
				// Walk every candidate buildPath can produce by marking each one
				// taken, until it runs out and throws.
				const taken = new Set<string>();
				const paths: string[] = [];
				for (;;) {
					let path: string;
					try {
						path = buildPath('Saive', 'Recipes', title, bad, taken);
					} catch {
						break;
					}
					paths.push(path);
					taken.add(path);
				}
				expect(paths.length, JSON.stringify(bad)).toBeGreaterThanOrEqual(2);
				for (const path of paths) {
					expect(path, `${JSON.stringify(bad)} / ${title}`).not.toContain('..');
					expect(path.split('/'), path).toHaveLength(3);
					expect(path.startsWith('Saive/Recipes/')).toBe(true);
				}
			}
		}
	});

	it('clamps a suffix longer than the cap instead of slicing from the end', () => {
		const suffix = 's'.repeat(130);
		expect(withSuffix('abcdef', suffix)).toBe(suffix);
		expect(withSuffix('abcdef', 'x'.repeat(118))).toBe('ab' + 'x'.repeat(118));
	});

	it('resolves a case-insensitive collision with the uuid8 suffix', () => {
		const taken = new Set(['saive/recipes/EXAMPLE SAVE.md']);
		expect(buildPath('Saive', 'Recipes', 'Example save', uuid, taken)).toBe(
			`Saive/Recipes/Example save (${uuid8}).md`,
		);
	});

	it('keeps the stem within 120 code points when it adds a suffix', () => {
		const title = 't'.repeat(200);
		const taken = new Set([`Saive/${'t'.repeat(120)}.md`]);
		const out = buildPath('Saive', null, title, uuid, taken);
		const stem = out.slice('Saive/'.length, -'.md'.length);
		expect(Array.from(stem)).toHaveLength(120);
		expect(stem.endsWith(` (${uuid8})`)).toBe(true);
	});

	it('falls back to the full uuid when the uuid8 path is taken too', () => {
		const taken = new Set([
			'Saive/x.md',
			`Saive/x (${uuid8}).md`,
		]);
		expect(buildPath('Saive', null, 'x', uuid, taken)).toBe(`Saive/x (${uuid}).md`);
	});

	it('throws instead of reusing a path when every candidate is taken', () => {
		const taken = new Set([
			'Saive/x.md',
			`Saive/x (${uuid8}).md`,
			`Saive/x (${uuid}).md`,
		]);
		expect(() => buildPath('Saive', null, 'x', uuid, taken)).toThrow(/x\.md/);
	});

	it('is deterministic', () => {
		const taken = new Set(['Saive/Recipes/Example save.md']);
		const a = buildPath('Saive', 'Recipes', 'Example: save?', uuid, taken);
		const b = buildPath('Saive', 'Recipes', 'Example: save?', uuid, taken);
		expect(a).toBe(b);
		expect(a).toBe(`Saive/Recipes/Example save (${uuid8}).md`);
	});

	it('collides across normalization forms', () => {
		const nfc = `Caf${String.fromCharCode(0xe9)}`;
		const nfd = `Cafe${String.fromCharCode(0x301)}`;
		const taken = new Set([`Saive/${nfd}.md`]);
		expect(buildPath('Saive', null, nfc, uuid, taken)).toBe(`Saive/${nfc} (${uuid8}).md`);
	});

	it('leaves the caller-supplied set untouched', () => {
		const taken = new Set(['Saive/x.md']);
		buildPath('Saive', null, 'x', uuid, taken);
		expect([...taken]).toEqual(['Saive/x.md']);
	});
});

describe('pathMatches', () => {
	const nfc = `Caf${String.fromCharCode(0xe9)}`;
	const nfd = `Cafe${String.fromCharCode(0x301)}`;

	it('accepts the plain path and either collision suffix', () => {
		expect(pathMatches('Saive/Recipes/x.md', 'Saive', 'Recipes', 'x', uuid)).toBe(true);
		expect(pathMatches(`Saive/Recipes/x (${uuid8}).md`, 'Saive', 'Recipes', 'x', uuid)).toBe(true);
		expect(pathMatches(`Saive/Recipes/x (${uuid}).md`, 'Saive', 'Recipes', 'x', uuid)).toBe(true);
	});

	it('rejects a different title, folder or case', () => {
		expect(pathMatches('Saive/Recipes/X.md', 'Saive', 'Recipes', 'x', uuid)).toBe(false);
		expect(pathMatches('Saive/x.md', 'Saive', 'Recipes', 'x', uuid)).toBe(false);
		expect(pathMatches('Saive/Recipes/y.md', 'Saive', 'Recipes', 'x', uuid)).toBe(false);
	});

	it('treats an NFD path from the adapter as the NFC path it built', () => {
		expect(pathMatches(`Saive/Recipes/${nfd}.md`, 'Saive', 'Recipes', nfc, uuid)).toBe(true);
		expect(pathMatches(`Saive/Recipes/${nfd}.md`, 'Saive', 'Recipes', nfd, uuid)).toBe(true);
	});
});
