import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/core is the part of the plugin vitest can run without Obsidian, and
// the part that runs unchanged on iOS and Android. This scan keeps it that
// way: no `obsidian` import, no Node or Electron module, in any shipped file
// under the directory. Test files may read fixtures with node:fs.
//
// The second suite guards rule 1 of CLAUDE.md across all of src/: the
// plugin is a read-only client. No file may name a mutating HTTP method or
// call fetch; every request goes through the HttpPort's `get`.

const dir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = fileURLToPath(new URL('..', import.meta.url));

const shipped = readdirSync(dir).filter(
	(name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

const IMPORT = /(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(IMPORT)) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined) found.push(specifier);
	}
	return found;
}

function walk(root: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) out.push(...walk(path));
		else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
	}
	return out;
}

describe('src/core stays pure', () => {
	it('has the nine shipped modules', () => {
		expect(shipped.sort()).toEqual([
			'client.ts',
			'contract.ts',
			'engine.ts',
			'filename.ts',
			'frontmatter.ts',
			'hash.ts',
			'link-code.ts',
			'plan.ts',
			'ports.ts',
		]);
	});

	it.each(shipped)('%s imports only sibling modules', (name) => {
		const source = readFileSync(`${dir}${name}`, 'utf8');
		for (const specifier of importsOf(source)) {
			expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\//);
		}
		expect(source).not.toMatch(/\bfrom\s+['"]obsidian['"]/);
		expect(source).not.toMatch(/\bfrom\s+['"](?:node:|electron)/);
		expect(source).not.toMatch(/\bprocess\.env\b/);
	});
});

describe('src/ is a read-only client', () => {
	const files = walk(srcDir);

	it('scans the shipped files', () => {
		expect(files.length).toBeGreaterThan(shipped.length);
	});

	it.each(files.map((f) => [f.slice(srcDir.length), f]))(
		'%s names no mutating method and never calls fetch',
		(_, path) => {
			const source = readFileSync(path, 'utf8');
			expect(source).not.toMatch(/method:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/i);
			expect(source).not.toMatch(/['"`](?:POST|PUT|PATCH|DELETE)['"`]/);
			expect(source).not.toMatch(/(?<![\w.])fetch\s*\(/);
			expect(source).not.toMatch(/\bXMLHttpRequest\b/);
		},
	);
});
