// The two hashes the planner reasons with. fullHash covers every byte and
// answers "do the files differ". bodyHash drops the leading frontmatter
// block and answers "did the user edit the body": Obsidian's property editor
// rewrites frontmatter on its own, and that must never count as a conflict.
//
// crypto.subtle and TextEncoder exist on Obsidian desktop and mobile, so the
// plugin needs no Node module and no hashing dependency.

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let hex = '';
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/**
 * The text with its leading frontmatter block removed. The block opens with
 * a first line of exactly `---` and closes at the next line of exactly `---`
 * (a trailing `\r` is allowed on either). The block and the closer's line
 * ending go; every other byte stays, line endings included. Text that does
 * not open a block, or never closes it, comes back untouched.
 */
export function stripFrontmatter(markdown: string): string {
	if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return markdown;
	let pos = markdown.indexOf('\n') + 1;
	while (pos <= markdown.length) {
		const newline = markdown.indexOf('\n', pos);
		const lineEnd = newline === -1 ? markdown.length : newline;
		let line = markdown.slice(pos, lineEnd);
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line === '---') return newline === -1 ? '' : markdown.slice(newline + 1);
		if (newline === -1) break;
		pos = newline + 1;
	}
	return markdown;
}

export function fullHash(markdown: string): Promise<string> {
	return sha256Hex(markdown);
}

export function bodyHash(markdown: string): Promise<string> {
	return sha256Hex(stripFrontmatter(markdown));
}
