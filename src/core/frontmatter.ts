// A small reader for one scalar field out of a leading frontmatter block.
// The engine uses it for the title of an oversize save, which arrives as
// bare markdown from /api/sync/file with no folder or title beside it, and
// the test fakes use it for `uuid` and `saive_schema`. The Obsidian adapter
// reads frontmatter through metadataCache instead, so this parser covers
// the shapes the Saive vault writer emits (js-yaml output: plain, quoted,
// and folded or literal block scalars) and nothing more exotic.

function blockLines(markdown: string): string[] | null {
	if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return null;
	const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
	const end = lines.indexOf('---', 1);
	if (end === -1) return null;
	return lines.slice(1, end);
}

function unquote(raw: string): string {
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		return raw
			.slice(1, -1)
			.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
				switch (esc[0]) {
					case 'n':
						return '\n';
					case 't':
						return '\t';
					case 'r':
						return '\r';
					case 'b':
						return '\b';
					case 'f':
						return '\f';
					case 'u':
						return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
					default:
						return esc;
				}
			});
	}
	if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
		return raw.slice(1, -1).replace(/''/g, "'");
	}
	// A plain scalar ends at the first ` #`, which opens a YAML comment.
	return raw.replace(/\s+#.*$/, '').trim();
}

function blockScalar(indicator: string, rest: string[]): string {
	const folded = indicator.startsWith('>');
	const chomp = indicator.includes('-') ? '' : '\n';
	const body: string[] = [];
	for (const line of rest) {
		if (line.trim() === '') {
			body.push('');
			continue;
		}
		if (!/^\s/.test(line)) break;
		body.push(line);
	}
	while (body.length > 0 && body[body.length - 1] === '') body.pop();
	const indent = Math.min(...body.filter((l) => l !== '').map((l) => l.length - l.trimStart().length));
	const stripped = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
	return (folded ? stripped.join(' ').replace(/ +/g, ' ') : stripped.join('\n')) + chomp;
}

/**
 * The value of a top-level `key: value` line in the frontmatter block, or
 * null when the block or the key is absent, or the value is a list or map.
 * Numbers and booleans come back as their source text.
 */
export function frontmatterField(markdown: string, key: string): string | null {
	const lines = blockLines(markdown);
	if (lines === null) return null;
	const prefix = `${key}:`;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!line.startsWith(prefix)) continue;
		const raw = line.slice(prefix.length);
		if (raw !== '' && !/^\s/.test(raw)) continue;
		const value = raw.trim();
		if (/^[>|][+-]?\d?$/.test(value)) return blockScalar(value, lines.slice(i + 1));
		if (value === '' || value.startsWith('- ') || value.startsWith('[') || value.startsWith('{')) {
			return null;
		}
		return unquote(value);
	}
	return null;
}
