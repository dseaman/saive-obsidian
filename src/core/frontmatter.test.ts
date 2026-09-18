import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frontmatterField } from './frontmatter';

// The engine names an oversize save's file from its frontmatter title when
// the server sends no title beside the entry. The Saive vault writer emits
// js-yaml output, so these cover the scalar shapes js-yaml produces.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../contracts/obsidian-sync-v1.json', import.meta.url)),
		'utf8',
	),
) as { pullResponse: { files: { markdown: string; title: string; uuid: string }[] } };

const fm = (block: string, body = '\nBody.\n') => `---\n${block}\n---${body}`;

describe('frontmatterField', () => {
	it('reads the fixture files', () => {
		for (const file of fixture.pullResponse.files) {
			expect(frontmatterField(file.markdown, 'title')).toBe(file.title);
			expect(frontmatterField(file.markdown, 'uuid')).toBe(file.uuid);
			expect(frontmatterField(file.markdown, 'saive_schema')).toBe('1');
		}
	});

	it('returns null without a block, without the key, or for a nested value', () => {
		expect(frontmatterField('# No block\n', 'title')).toBeNull();
		expect(frontmatterField('---\ntitle: never closed\n', 'title')).toBeNull();
		expect(frontmatterField(fm('url: x'), 'title')).toBeNull();
		expect(frontmatterField(fm('tags:\n  - a\n  - b'), 'tags')).toBeNull();
		expect(frontmatterField(fm('title_extra: x'), 'title')).toBeNull();
	});

	it('unquotes double and single quoted scalars', () => {
		expect(frontmatterField(fm('title: "Foo: \\"bar\\" \\u00e9"'), 'title')).toBe('Foo: "bar" é');
		expect(frontmatterField(fm("title: 'It''s #1'"), 'title')).toBe("It's #1");
	});

	it('drops a trailing comment from a plain scalar', () => {
		expect(frontmatterField(fm('title: Plain title # note'), 'title')).toBe('Plain title');
		expect(frontmatterField(fm('title: C#'), 'title')).toBe('C#');
	});

	it('joins folded and literal block scalars', () => {
		expect(frontmatterField(fm('title: >-\n  A long\n  title\nurl: x'), 'title')).toBe(
			'A long title',
		);
		expect(frontmatterField(fm('title: |\n  line one\n  line two\nurl: x'), 'title')).toBe(
			'line one\nline two\n',
		);
	});

	it('tolerates CRLF line endings', () => {
		expect(frontmatterField('---\r\ntitle: Windows\r\n---\r\nBody', 'title')).toBe('Windows');
	});
});
