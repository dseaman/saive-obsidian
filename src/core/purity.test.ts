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
	it('has the ten shipped modules', () => {
		expect(shipped.sort()).toEqual([
			'client.ts',
			'contract.ts',
			'engine.ts',
			'filename.ts',
			'frontmatter.ts',
			'hash.ts',
			'link-code.ts',
			'link.ts',
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

// Rule 2 of CLAUDE.md: the token lives in app.secretStorage and nowhere
// else. One module talks to that store; nothing else names it, and nothing
// writes the secret through saveData or localStorage.
describe('src/ keeps the token in one place', () => {
	const files = walk(srcDir);

	// Comments may explain where the token lives; code may not touch it.
	function code(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	}

	it.each(files.map((f) => [f.slice(srcDir.length), f]))(
		'%s touches secretStorage only through token-store.ts',
		(name, path) => {
			const source = code(readFileSync(path, 'utf8'));
			if (name.endsWith('obsidian/token-store.ts')) return;
			expect(source).not.toMatch(/\bsecretStorage\b/);
			// link.ts defines the key; token-store.ts is the only other file that may name it.
			if (!name.endsWith('core/link.ts')) expect(source).not.toMatch(/\bSECRET_KEY\b|saive-sync-token/);
		},
	);

	it('never hands a secret to saveData or localStorage', () => {
		for (const path of files) {
			const source = readFileSync(path, 'utf8');
			expect(source, path).not.toMatch(/(?:saveData|saveLocalStorage)\([^)]*\b(?:secret|token)\b/i);
		}
	});

	// A secret is stored by runLinkFlow after the server accepted it, and by
	// nothing else: main.ts hands the store over, it never calls set itself.
	it('stores a secret only through runLinkFlow', () => {
		for (const path of files) {
			const name = path.slice(srcDir.length);
			const source = code(readFileSync(path, 'utf8'));
			if (name.endsWith('obsidian/token-store.ts')) continue;
			expect(source, name).not.toMatch(/\btokens\.set\(|\bsetSecret\(/);
			if (!name.endsWith('core/link.ts')) expect(source, name).not.toMatch(/\bstore\.set\(/);
		}
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
