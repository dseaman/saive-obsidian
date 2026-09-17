import { Plugin } from 'obsidian';

// Saive for Obsidian: a one-way mirror of a Saive library. Saive's storage is
// the source of truth, so this plugin reads from app.saive.my and never writes
// back. The sync engine, settings tab and commands arrive in later releases;
// this release proves the build, test and release pipeline.
export default class SaivePlugin extends Plugin {
	onload(): void {}
}
