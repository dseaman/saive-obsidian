// The mass-trash guard's prompt. The engine calls confirmMassTrash when a
// page would trash more files than max(20, 10% of tracked); this modal
// resolves true on "Move to trash" and false on cancel, close or Escape.

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

export class MassTrashModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private readonly count: number,
		private readonly tracked: number,
		private readonly resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Saive wants to trash many files');
		this.contentEl.createEl('p', {
			text: `This sync would move ${this.count} of your ${this.tracked} synced notes to the trash, because those saves are gone from Saive. Cancel keeps every file and pauses sync until you decide.`,
		});
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').setCta().onClick(() => {
					this.decide(false);
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Move to trash').onClick(() => {
					this.decide(true);
				}),
			);
	}

	onClose(): void {
		this.decide(false);
		this.contentEl.empty();
	}

	private decide(ok: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.resolve(ok);
		this.close();
	}
}

export function confirmMassTrash(app: App, count: number, tracked: number): Promise<boolean> {
	return new Promise((resolve) => {
		new MassTrashModal(app, count, tracked, resolve).open();
	});
}
