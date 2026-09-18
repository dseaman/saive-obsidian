// The sync token's only home: app.secretStorage (Obsidian 1.11.4 and
// later). The token reads a whole private library, and data.json travels
// with the vault into public git repos and sync services, so nothing in
// this plugin writes the token anywhere else, logs it, or shows it in a
// notice. The manifest's minAppVersion keeps older apps out; the guard
// here keeps a missing secretStorage from becoming a crash on one that
// slipped through.

import type { App } from 'obsidian';
import { SECRET_KEY } from '../core/link';

export class SecretStorageUnavailableError extends Error {
	constructor() {
		super('Saive needs Obsidian 1.11.4 or later');
		this.name = 'SecretStorageUnavailableError';
	}
}

export class TokenStore {
	constructor(private readonly app: App) {}

	available(): boolean {
		const storage: unknown = this.app.secretStorage;
		return typeof storage === 'object' && storage !== null;
	}

	get(): Promise<string | null> {
		if (!this.available()) return Promise.resolve(null);
		const secret = this.app.secretStorage.getSecret(SECRET_KEY);
		return Promise.resolve(secret === '' ? null : secret);
	}

	set(secret: string): Promise<void> {
		if (!this.available()) return Promise.reject(new SecretStorageUnavailableError());
		this.app.secretStorage.setSecret(SECRET_KEY, secret);
		return Promise.resolve();
	}

	clear(): Promise<void> {
		if (!this.available()) return Promise.resolve();
		// The API has no delete; an empty value reads back as null above.
		this.app.secretStorage.setSecret(SECRET_KEY, '');
		return Promise.resolve();
	}
}
