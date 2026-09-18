import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bodyHash, fullHash, sha256Hex, stripFrontmatter } from './hash';

// Two hashes drive the planner. fullHash answers "do the bytes differ";
// bodyHash answers "did the user edit the body", and must ignore the
// frontmatter that Obsidian's property editor rewrites while keeping every
// other byte, line endings included.

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../../contracts/obsidian-sync-v1.json', import.meta.url),
		),
		'utf8',
	),
) as {
	tokenHashVector: { secret: string; sha256Hex: string };
	pullResponse: { files: { markdown: string }[] };
};

const sample = fixture.pullResponse.files[0]!.markdown;

describe('sha256Hex', () => {
	it('matches the frozen token hash vector', async () => {
		const { secret, sha256Hex: expected } = fixture.tokenHashVector;
		expect(await sha256Hex(secret)).toBe(expected);
	});

	it('hashes the UTF-8 bytes, so an emoji changes the digest', async () => {
		expect(await sha256Hex('a')).not.toBe(await sha256Hex('\u{1F4DA}'));
		expect(await sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('keeps the leading zero of a byte below 0x10', async () => {
		expect(await sha256Hex(sample)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('stripFrontmatter', () => {
	it('removes the block and its closing newline, nothing else', () => {
		expect(stripFrontmatter('---\na: 1\n---\n\nBody\n')).toBe('\nBody\n');
		expect(stripFrontmatter('---\na: 1\n---\nBody')).toBe('Body');
	});

	it('accepts CRLF on the opener and the closer', () => {
		expect(stripFrontmatter('---\r\na: 1\r\n---\r\nBody\r\n')).toBe('Body\r\n');
		expect(stripFrontmatter('---\na: 1\n---\r\nBody')).toBe('Body');
	});

	it('treats a closer at end of file as an empty body', () => {
		expect(stripFrontmatter('---\na: 1\n---')).toBe('');
	});

	it('treats the whole file as body when nothing closes the block', () => {
		const text = '---\na: 1\nno closer\n';
		expect(stripFrontmatter(text)).toBe(text);
	});

	it('leaves text that does not open with --- alone', () => {
		expect(stripFrontmatter('Body\n---\n')).toBe('Body\n---\n');
		expect(stripFrontmatter('----\na: 1\n---\n')).toBe('----\na: 1\n---\n');
		expect(stripFrontmatter('--- \na: 1\n---\n')).toBe('--- \na: 1\n---\n');
		expect(stripFrontmatter('')).toBe('');
	});

	it('ignores lines that only resemble the closer', () => {
		expect(stripFrontmatter('---\na: 1\n----\n--- \n---\nBody')).toBe('Body');
	});
});

describe('bodyHash', () => {
	it('ignores a frontmatter edit', async () => {
		const edited = sample.replace('status: unread', 'status: read');
		expect(edited).not.toBe(sample);
		expect(await bodyHash(edited)).toBe(await bodyHash(sample));
		expect(await fullHash(edited)).not.toBe(await fullHash(sample));
	});

	it('changes when the body changes', async () => {
		const edited = sample.replace('Mine.', 'Yours.');
		expect(await bodyHash(edited)).not.toBe(await bodyHash(sample));
	});

	it('keeps CRLF and trailing spaces as bytes', async () => {
		expect(sample).toContain('\r\n');
		expect(sample).toContain('  \n');
		const lf = sample.replace(/\r\n/g, '\n');
		const trimmed = sample.replace('  \n', '\n');
		expect(await bodyHash(lf)).not.toBe(await bodyHash(sample));
		expect(await bodyHash(trimmed)).not.toBe(await bodyHash(sample));
	});

	it('equals the sha256 of the stripped text', async () => {
		expect(await bodyHash(sample)).toBe(await sha256Hex(stripFrontmatter(sample)));
	});
});

describe('fullHash', () => {
	it('equals the sha256 of the whole text', async () => {
		expect(await fullHash(sample)).toBe(await sha256Hex(sample));
	});
});
