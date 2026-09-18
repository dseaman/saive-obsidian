// VaultPort over the Obsidian vault API. No sync logic lives here: the
// engine decides, this file performs. Every path passes through
// normalizePath, overwrites go through vault.process so an open editor
// follows along, and deletes and moves go through fileManager so Obsidian
// updates links and honors the user's trash setting.

import { normalizePath, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { VaultPort } from '../core/ports';

function parentOf(path: string): string | null {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? null : path.slice(0, slash);
}

export class ObsidianVault implements VaultPort {
	constructor(private readonly app: App) {}

	async listMarkdown(root: string): Promise<string[]> {
		const prefix = `${normalizePath(root)}/`;
		return this.app.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((p) => p.startsWith(prefix));
	}

	async uuidOf(path: string): Promise<string | null> {
		const file = this.fileAt(path);
		if (file === null) return null;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm === undefined) return null;
		const uuid: unknown = fm.uuid;
		const schema: unknown = fm.saive_schema;
		if (schema === undefined || schema === null) return null;
		return typeof uuid === 'string' ? uuid : null;
	}

	async read(path: string): Promise<string> {
		const file = this.fileAt(path);
		if (file === null) throw new Error(`Not a file: ${path}`);
		return this.app.vault.read(file);
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(normalizePath(path));
	}

	async write(path: string, markdown: string): Promise<void> {
		const normalized = normalizePath(path);
		const file = this.fileAt(normalized);
		if (file !== null) {
			await this.app.vault.process(file, () => markdown);
			return;
		}
		await this.ensureFolder(parentOf(normalized));
		await this.app.vault.create(normalized, markdown);
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.fileAt(from);
		if (file === null) throw new Error(`Not a file: ${from}`);
		const target = normalizePath(to);
		await this.ensureFolder(parentOf(target));
		await this.app.fileManager.renameFile(file, target);
	}

	async trash(path: string): Promise<void> {
		const file = this.fileAt(path);
		if (file === null) return;
		await this.app.fileManager.trashFile(file);
	}

	async copy(from: string, to: string): Promise<void> {
		const markdown = await this.read(from);
		const target = normalizePath(to);
		await this.ensureFolder(parentOf(target));
		await this.app.vault.create(target, markdown);
	}

	private fileAt(path: string): TFile | null {
		const found = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return found instanceof TFile ? found : null;
	}

	private async ensureFolder(folder: string | null): Promise<void> {
		if (folder === null || folder === '') return;
		const found = this.app.vault.getAbstractFileByPath(folder);
		if (found instanceof TFolder) return;
		if (found !== null) throw new Error(`A file sits where a folder is needed: ${folder}`);
		await this.ensureFolder(parentOf(folder));
		try {
			await this.app.vault.createFolder(folder);
		} catch (err) {
			// Two syncs on two devices can race a shared folder into being.
			if (this.app.vault.getAbstractFileByPath(folder) instanceof TFolder) return;
			throw err;
		}
	}
}
