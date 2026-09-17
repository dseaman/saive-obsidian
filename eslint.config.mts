import obsidianmd from 'eslint-plugin-obsidianmd';
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
		// Tests run under vitest on Node and never ship in main.js, so they may
		// read fixtures with node:fs. The rule stays on for everything else:
		// shipped code runs on iOS and Android, where Node APIs do not exist.
		files: ['src/**/*.test.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
