import { describe, expect, it } from 'vitest';
import { buildPath, sanitizeTitle } from './filename';

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

	it('suffixes Windows reserved names, with or without an extension', () => {
		for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'lpt9']) {
			expect(buildPath('Saive', null, name, uuid, new Set())).toBe(
				`Saive/${name} (${uuid8}).md`,
			);
		}
		expect(buildPath('Saive', null, 'con.txt', uuid, new Set())).toBe(
			`Saive/con.txt (${uuid8}).md`,
		);
		expect(buildPath('Saive', null, 'CONSOLE', uuid, new Set())).toBe(
			'Saive/CONSOLE.md',
		);
		expect(buildPath('Saive', null, 'COM0', uuid, new Set())).toBe('Saive/COM0.md');
		expect(buildPath('Saive', 'NUL', 'x', uuid, new Set())).toBe(
			`Saive/NUL (${uuid8})/x.md`,
		);
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

	it('leaves the caller-supplied set untouched', () => {
		const taken = new Set(['Saive/x.md']);
		buildPath('Saive', null, 'x', uuid, taken);
		expect([...taken]).toEqual(['Saive/x.md']);
	});
});
