// Vault paths for saves. The same title must land at the same path on every
// device that syncs the same library, so every rule here is a pure function
// of its inputs: no clock, no random, no locale.
//
// Path shape: <root>/<folder>/<title>.md, or <root>/<title>.md for an unfiled
// save. Forward slashes throughout; the adapter runs normalizePath later.

// Characters Windows, macOS and Linux reject in a file name (\ / : * ? " < > |),
// the ones that break an Obsidian wiki link ([ ] # ^ |), and control characters.
const REPLACED = /[\\/:*?"<>|[\]#^\p{Cc}]/gu;

// Windows refuses these as a base name, with any extension, in any case.
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

const EDGE_DOTS_AND_SPACES = /^[. ]+|[. ]+$/g;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/g;

/** Maximum length of a file stem or folder name, counted in code points. */
export const MAX_STEM = 120;

/**
 * Clean a title (or a folder name) into a file-system-safe stem. May return
 * an empty string; buildPath falls back to the uuid in that case.
 */
export function sanitizeTitle(title: string): string {
	const cleaned = title
		.normalize('NFC')
		.replace(REPLACED, ' ')
		.replace(/\s+/g, ' ')
		.replace(EDGE_DOTS_AND_SPACES, '');
	return cutCodePoints(cleaned, MAX_STEM).replace(EDGE_DOTS_AND_SPACES, '');
}

// Array.from walks code points, so a surrogate pair never splits.
function cutCodePoints(s: string, max: number): string {
	const points = Array.from(s);
	return points.length <= Math.max(0, max) ? s : points.slice(0, Math.max(0, max)).join('');
}

/** Append a suffix to a stem, cutting the stem so the whole stays within MAX_STEM. */
export function withSuffix(stem: string, suffix: string): string {
	const room = Math.max(0, MAX_STEM - Array.from(suffix).length);
	return cutCodePoints(stem, room).replace(EDGE_DOTS_AND_SPACES, '') + suffix;
}

// Windows reads the part before the first dot as the base name, so the tag
// that breaks the reserved name goes there: `con.txt` becomes `con (x).txt`.
function unreserve(stem: string, tag: string): string {
	const dot = stem.indexOf('.');
	const front = (dot === -1 ? stem : stem.slice(0, dot)) + tag;
	const tail = dot === -1 ? '' : stem.slice(dot);
	const room = MAX_STEM - Array.from(front).length;
	return front + cutCodePoints(tail, room).replace(TRAILING_DOTS_AND_SPACES, '');
}

interface Ids {
	/** First 8 characters, the short collision suffix. */
	short: string;
	full: string;
}

// The contract guard admits canonical uuids alone, which pass this filter
// untouched. It still runs, so a value that slipped past the guard can never
// carry `..` or a slash into a path.
function safeIds(uuid: string): Ids {
	const full = sanitizeTitle(uuid) || 'save';
	const short = Array.from(full).slice(0, 8).join('').replace(EDGE_DOTS_AND_SPACES, '') || full;
	return { short, full };
}

function titleStem(title: string, ids: Ids): string {
	const stem = sanitizeTitle(title);
	if (stem === '') return ids.short;
	if (WINDOWS_RESERVED.test(stem)) return unreserve(stem, ` (${ids.short})`);
	return stem;
}

// A folder's name must come from the folder alone, never from a save's
// uuid, or a reserved folder name would split into one directory per save.
function folderDir(folder: string): string | null {
	const stem = sanitizeTitle(folder);
	if (stem === '') return null;
	if (WINDOWS_RESERVED.test(stem)) return unreserve(stem, ' (folder)');
	return stem;
}

function join(...parts: (string | null)[]): string {
	return parts.filter((p): p is string => p !== null && p !== '').join('/');
}

/** Case-insensitive, normalization-insensitive form for collision checks. */
function collisionKey(path: string): string {
	return path.normalize('NFC').toLowerCase();
}

/** The file stem (name without .md) a title maps to, before collision handling. */
export function stemFor(title: string, uuid: string): string {
	return titleStem(title, safeIds(uuid));
}

/** The directory a folder maps to under root. An empty folder name lands in root. */
export function dirFor(root: string, folder: string | null): string {
	const cleanRoot = root.normalize('NFC').replace(/^\/+|\/+$/g, '');
	return join(cleanRoot, folder === null ? null : folderDir(folder));
}

// Every path buildPath may return for a save, in order of preference.
function candidates(dir: string, title: string, ids: Ids): string[] {
	const stem = titleStem(title, ids);
	return [stem, withSuffix(stem, ` (${ids.short})`), withSuffix(stem, ` (${ids.full})`)].map(
		(name) => join(dir, `${name}.md`),
	);
}

/**
 * The path a save belongs at. `taken` holds every path already in use; the
 * comparison ignores case and Unicode normalization form because macOS and
 * Windows disks do. A collision takes a ` (uuid8)` suffix, then the full
 * uuid, then throws: the planner must never hand the adapter a path that
 * would overwrite someone else's file.
 */
export function buildPath(
	root: string,
	folder: string | null,
	title: string,
	uuid: string,
	taken: ReadonlySet<string>,
): string {
	const options = candidates(dirFor(root, folder), title, safeIds(uuid));
	const used = new Set<string>();
	for (const p of taken) used.add(collisionKey(p));
	for (const path of options) {
		if (!used.has(collisionKey(path))) return path;
	}
	throw new Error(`No free path for ${options[0] ?? title}`);
}

/**
 * Whether `path` is where buildPath would place this save, allowing for a
 * collision suffix it may have received. The planner uses this to tell a
 * remote title or folder change from a file that simply carries a suffix.
 * Case matters (a case-only rename is a rename); normalization form does
 * not, because macOS may hand back NFD names for NFC files.
 */
export function pathMatches(
	path: string,
	root: string,
	folder: string | null,
	title: string,
	uuid: string,
): boolean {
	const nfc = path.normalize('NFC');
	return candidates(dirFor(root, folder), title, safeIds(uuid)).some((c) => c === nfc);
}
