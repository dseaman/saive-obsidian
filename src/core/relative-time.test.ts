import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
	it('calls anything under a minute "now"', () => {
		expect(relativeTime(NOW, NOW, 'en')).toBe('now');
		expect(relativeTime(NOW - 59 * SECOND, NOW, 'en')).toBe('now');
	});

	it('counts minutes, hours and days in the past', () => {
		expect(relativeTime(NOW - MINUTE, NOW, 'en')).toBe('1 minute ago');
		expect(relativeTime(NOW - 15 * MINUTE, NOW, 'en')).toBe('15 minutes ago');
		expect(relativeTime(NOW - 2 * HOUR, NOW, 'en')).toBe('2 hours ago');
		expect(relativeTime(NOW - DAY, NOW, 'en')).toBe('yesterday');
		expect(relativeTime(NOW - 3 * DAY, NOW, 'en')).toBe('3 days ago');
	});

	it('moves to months and years for old syncs', () => {
		expect(relativeTime(NOW - 45 * DAY, NOW, 'en')).toBe('last month');
		expect(relativeTime(NOW - 400 * DAY, NOW, 'en')).toBe('last year');
	});

	it('treats a clock skewed into the future as now', () => {
		expect(relativeTime(NOW + 5 * MINUTE, NOW, 'en')).toBe('now');
	});

	it('follows the app language', () => {
		expect(relativeTime(NOW - 15 * MINUTE, NOW, 'de')).toBe('vor 15 Minuten');
	});

	it('falls back to English for a language Intl rejects', () => {
		expect(relativeTime(NOW - 15 * MINUTE, NOW, 'not a locale')).toBe('15 minutes ago');
	});
});
