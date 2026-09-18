import obsidianmd from 'eslint-plugin-obsidianmd';
// A deep import: the plugin exports no brand list from its entry. The
// package version is pinned exactly in package.json so the path cannot
// drift under a caret update.
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'contracts',
		'scripts',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'vitest.config.ts',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The sentence-case rule lowercases any capitalized word mid-sentence
		// unless it is a known brand. Saive is one; the default list stays.
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					enforceCamelCaseLower: true,
					brands: ['Saive', 'app.saive.my', 'saive.my', ...DEFAULT_BRANDS],
				},
			],
		},
	},
	{
		// Tests run under vitest on Node and never ship in main.js, so they may
		// read fixtures with node:fs. The rule stays on for everything else:
		// shipped code runs on iOS and Android, where Node APIs do not exist.
		files: ['src/**/*.test.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
