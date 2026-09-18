import { describe, expect, it } from 'vitest';
import { cleanRoot, DEFAULT_SETTINGS, settingsFrom } from './settings';

// settingsFrom reads whatever data.json holds. A root that cleans to
// nothing would put every save at the vault's top level, so it falls back
// to the default; the engine refuses an empty root on its side too.

describe('settingsFrom', () => {
	it('returns the defaults for missing or malformed input', () => {
		expect(settingsFrom(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom('Saive')).toEqual(DEFAULT_SETTINGS);
		expect(settingsFrom({ root: 7, intervalMinutes: 'soon' })).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps a valid root and interval', () => {
		expect(settingsFrom({ root: 'Library/Saive', intervalMinutes: 0 })).toEqual({
			root: 'Library/Saive',
			intervalMinutes: 0,
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

	it('rejects a negative or non-finite interval', () => {
		expect(settingsFrom({ intervalMinutes: -1 }).intervalMinutes).toBe(15);
		expect(settingsFrom({ intervalMinutes: Number.NaN }).intervalMinutes).toBe(15);
	});
});
