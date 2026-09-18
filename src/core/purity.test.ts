import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/core is the part of the plugin vitest can run without Obsidian, and
// the part that runs unchanged on iOS and Android. This scan keeps it that
// way: no `obsidian` import, no Node or Electron module, in any shipped file
// under the directory. Test files may read fixtures with node:fs.

const dir = fileURLToPath(new URL('.', import.meta.url));

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

describe('src/core stays pure', () => {
	it('has the five shipped modules', () => {
		expect(shipped.sort()).toEqual([
			'contract.ts',
			'filename.ts',
			'hash.ts',
			'link-code.ts',
			'plan.ts',
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
