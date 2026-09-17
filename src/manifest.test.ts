import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Obsidian's community directory reads manifest.json at the head of the
// default branch and downloads release assets by the tag that equals
// `version`. These checks catch the mistakes that fail its review or break
// installs: a version that drifted between files, an id the directory rejects,
// a description outside its rules.

function readJson<T>(name: string): T {
	return JSON.parse(
		readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'),
	) as T;
}

interface Manifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	isDesktopOnly: boolean;
	fundingUrl?: string;
}

const manifest = readJson<Manifest>('manifest.json');
const pkg = readJson<{ version: string }>('package.json');
const versions = readJson<Record<string, string>>('versions.json');

describe('manifest.json', () => {
	it('uses a plain x.y.z version that matches package.json', () => {
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.version).toBe(manifest.version);
	});

	it('maps its version to minAppVersion in versions.json', () => {
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});

	it('requires an app version that ships secret storage', () => {
		// The sync token reads a whole private library, and many people commit
		// .obsidian/ to public git. The token lives in app.secretStorage
		// (1.11.4 and later) and never in data.json, so no older app may load
		// this plugin.
		const [major = 0, minor = 0, patch = 0] = manifest.minAppVersion
			.split('.')
			.map(Number);
		const atLeast =
			major > 1 ||
			(major === 1 && (minor > 11 || (minor === 11 && patch >= 4)));
		expect(atLeast).toBe(true);
	});

	it('has an id the directory accepts', () => {
		expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
		expect(manifest.id).not.toContain('obsidian');
		expect(manifest.id.endsWith('plugin')).toBe(false);
	});

	it('has a description inside the directory rules', () => {
		expect(manifest.description.length).toBeLessThanOrEqual(250);
		expect(manifest.description.endsWith('.')).toBe(true);
		expect(manifest.description.startsWith('This is a plugin')).toBe(false);
	});

	it('supports mobile and asks for no funding', () => {
		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.fundingUrl).toBeUndefined();
	});
});
