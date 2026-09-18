import { describe, expect, it } from 'vitest';
import {
	AUTO_SYNC_OPTIONS,
	autoSyncFrom,
	autoSyncLabel,
	cleanRoot,
	DEFAULT_AUTO_SYNC,
	DEFAULT_SETTINGS,
	rootProblem,
	settingsFrom,
} from './settings';

// settingsFrom reads whatever data.json holds. A root that cleans to
// nothing would put every save at the vault's top level, so it falls back
// to the default; the engine refuses an empty root on its side too.
// autoSyncFrom reads the per-device value from localStorage, including the
// boolean an earlier build wrote there.

describe('settingsFrom', () => {
	it('returns the defaults for missing or malformed input', () => {
		expect(settingsFrom(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom('Saive')).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom({ root: 7 })).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps a valid root and drops fields it no longer stores', () => {
		expect(settingsFrom({ root: 'Library/Saive', intervalMinutes: 0 })).toEqual({
			root: 'Library/Saive',
		});
	});

	it('cleans surrounding whitespace and slashes from the root', () => {
		expect(settingsFrom({ root: ' /Notes/ ' }).root).toBe('Notes');
		expect(cleanRoot('//a/b//')).toBe('a/b');
	});

	it('falls back to the default root when the root cleans to nothing', () => {
		for (const root of ['', '   ', '/', ' // ']) {
			expect(settingsFrom({ root }).root).toBe(DEFAULT_SETTINGS.root);
		}
	});

	it('falls back to the default root when a segment would leave the vault', () => {
		for (const root of ['..', '../Saive', 'Saive/..', 'Notes/../Saive', '/../x']) {
			expect(settingsFrom({ root }).root).toBe(DEFAULT_SETTINGS.root);
		}
		// Dots inside a name are a name, not a step up.
		expect(settingsFrom({ root: 'Saive..old' }).root).toBe('Saive..old');
		expect(settingsFrom({ root: '.saive' }).root).toBe('.saive');
	});
});

describe('rootProblem', () => {
	it('names the reason the settings tab shows', () => {
		expect(rootProblem('')).toBe('empty');
		expect(rootProblem('a/../b')).toBe('escapes');
		expect(rootProblem('..')).toBe('escapes');
		expect(rootProblem('Library/Saive')).toBeNull();
	});
});

describe('autoSyncFrom', () => {
	it('defaults to every 15 minutes when nothing is stored', () => {
		expect(autoSyncFrom(null)).toBe(15);
		expect(autoSyncFrom(undefined)).toBe(15);
		expect(DEFAULT_AUTO_SYNC).toBe(15);
	});

	it('accepts each option as a number or a string', () => {
		for (const option of AUTO_SYNC_OPTIONS) {
			expect(autoSyncFrom(option)).toBe(option);
			expect(autoSyncFrom(String(option))).toBe(option);
		}
	});

	it('reads the boolean flag an earlier build stored', () => {
		expect(autoSyncFrom(false)).toBe(0);
		expect(autoSyncFrom(true)).toBe(15);
	});

	it('falls back to the default for anything else', () => {
		expect(autoSyncFrom(7)).toBe(15);
		expect(autoSyncFrom(-15)).toBe(15);
		expect(autoSyncFrom('soon')).toBe(15);
		expect(autoSyncFrom({})).toBe(15);
	});

	it('labels every option in sentence case', () => {
		expect(AUTO_SYNC_OPTIONS.map(autoSyncLabel)).toEqual(['Off', 'Every 15 minutes', 'Every hour']);
	});
});
