import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

// Obsidian's directory review rebuilds main.js from source and compares it to
// the release asset. A build that embeds a timestamp or reads the environment
// fails that review after the release is already public. This script builds
// twice from a clean state and fails when the bytes differ.

function buildAndHash() {
	rmSync('main.js', { force: true });
	const result = spawnSync(
		process.execPath,
		['esbuild.config.mjs', 'production'],
		{ stdio: 'inherit' },
	);
	if (result.status !== 0) {
		console.error('build failed');
		process.exit(1);
	}
	return createHash('sha256').update(readFileSync('main.js')).digest('hex');
}

const first = buildAndHash();
const second = buildAndHash();

if (first !== second) {
	console.error(`main.js differs between two builds:\n  ${first}\n  ${second}`);
	process.exit(1);
}
console.log(`main.js is reproducible: sha256 ${first}`);
