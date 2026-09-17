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
	return points.length <= max ? s : points.slice(0, max).join('');
}

/** Append a suffix to a stem, cutting the stem so the whole stays within MAX_STEM. */
export function withSuffix(stem: string, suffix: string): string {
	const room = MAX_STEM - Array.from(suffix).length;
	return cutCodePoints(stem, room).replace(EDGE_DOTS_AND_SPACES, '') + suffix;
}

function segment(name: string, uuid8: string): string {
	const stem = sanitizeTitle(name);
	if (stem === '') return uuid8;
	if (WINDOWS_RESERVED.test(stem)) return withSuffix(stem, ` (${uuid8})`);
	return stem;
}

function join(...parts: (string | null)[]): string {
	return parts.filter((p): p is string => p !== null && p !== '').join('/');
}

/** The file stem (name without .md) a title maps to, before collision handling. */
export function stemFor(title: string, uuid: string): string {
	return segment(title, uuid.slice(0, 8));
}

/** The directory a folder maps to under root. An empty folder name lands in root. */
export function dirFor(root: string, folder: string | null, uuid: string): string {
	const cleanRoot = root.replace(/^\/+|\/+$/g, '');
	if (folder === null || sanitizeTitle(folder) === '') return cleanRoot;
	return join(cleanRoot, segment(folder, uuid.slice(0, 8)));
}

/**
 * The path a save belongs at. `taken` holds every path already in use; the
 * comparison is case-insensitive because macOS and Windows disks are. A
 * collision takes a ` (uuid8)` suffix, then the full uuid, then throws:
 * the planner must never hand the adapter a path that would overwrite
 * someone else's file.
 */
export function buildPath(
	root: string,
	folder: string | null,
	title: string,
	uuid: string,
	taken: ReadonlySet<string>,
): string {
	const uuid8 = uuid.slice(0, 8);
	const dir = dirFor(root, folder, uuid);
	const stem = stemFor(title, uuid);
	const lower = new Set<string>();
	for (const p of taken) lower.add(p.toLowerCase());

	const candidates = [stem, withSuffix(stem, ` (${uuid8})`), withSuffix(stem, ` (${uuid})`)];
	for (const candidate of candidates) {
		const path = join(dir, `${candidate}.md`);
		if (!lower.has(path.toLowerCase())) return path;
	}
	throw new Error(`No free path for ${join(dir, `${stem}.md`)}`);
}

/**
 * Whether `path` is where buildPath would place this save, allowing for a
 * collision suffix it may have received. The planner uses this to tell a
 * remote title or folder change from a file that simply carries a suffix.
 */
export function pathMatches(
	path: string,
	root: string,
	folder: string | null,
	title: string,
	uuid: string,
): boolean {
	const dir = dirFor(root, folder, uuid);
	const stem = stemFor(title, uuid);
	const uuid8 = uuid.slice(0, 8);
	const accepted = [stem, withSuffix(stem, ` (${uuid8})`), withSuffix(stem, ` (${uuid})`)];
	return accepted.some((candidate) => join(dir, `${candidate}.md`) === path);
}
