// "15 minutes ago" for the settings tab's "Last sync" line. Replaces
// obsidian's re-exported moment: the directory's review cannot resolve
// moment's types, so moment(...).fromNow() lints as an unsafe call on an
// error-typed value. Intl.RelativeTimeFormat ships in every Obsidian
// runtime, desktop and mobile.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function formatter(language: string): Intl.RelativeTimeFormat {
	try {
		return new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
	} catch {
		return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	}
}

/** How long before `now` the time `at` was, in the app language. */
export function relativeTime(at: number, now: number, language: string): string {
	const rtf = formatter(language);
	const ago = now - at;
	if (ago < MINUTE) return rtf.format(0, 'second');
	if (ago < HOUR) return rtf.format(-Math.floor(ago / MINUTE), 'minute');
	if (ago < DAY) return rtf.format(-Math.floor(ago / HOUR), 'hour');
	if (ago < MONTH) return rtf.format(-Math.floor(ago / DAY), 'day');
	if (ago < YEAR) return rtf.format(-Math.floor(ago / MONTH), 'month');
	return rtf.format(-Math.floor(ago / YEAR), 'year');
}
