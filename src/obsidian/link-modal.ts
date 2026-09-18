// The link modal. It shows the six-character code for the hash the plugin
// just sent to the consent page, and polls /api/sync/me until the user
// approves there. The code is the whole point: a phishing page could send
// a signed-in user to /obsidian/connect with an attacker's hash, and the
// only thing that page cannot fake is what this modal shows. So the code
// is large, first, and the instruction says to compare.
//
// Nothing here outlives the modal: the poll loop reads `cancelled`, and
// closing the modal wakes any pending wait so the loop exits at once.

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { pollUntilLinked } from '../core/link';
import type { MeClient } from '../core/link';

export interface LinkModalOptions {
	code: string;
	url: string;
	client: MeClient;
	openUrl: (url: string) => void;
	/** Runs after the modal closes on a successful link. */
	onLinked: () => void;
	/** Runs whenever the modal closes: linked, cancelled, timed out or unloaded. */
	onClosed: () => void;
}

export class LinkModal extends Modal {
	private cancelled = false;
	private wake: (() => void) | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly opts: LinkModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Connect to Saive');
		const { contentEl } = this;
		contentEl.createEl('p', {
			text: 'Approve this vault on the Saive page that just opened. Check that the page shows this code:',
		});
		contentEl.createDiv({ cls: 'saive-link-code', text: this.opts.code });
		this.statusEl = contentEl.createEl('p', {
			cls: 'saive-link-status',
			text: 'If the codes differ, close this and start again.',
		});
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText('Open the page again').onClick(() => {
					this.opts.openUrl(this.opts.url);
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			);
		void this.poll();
	}

	onClose(): void {
		this.cancelled = true;
		this.wake?.();
		this.contentEl.empty();
		this.opts.onClosed();
	}

	/** obsidian://saive?linked=1 arrived: skip the rest of the current wait. */
	pollNow(): void {
		this.wake?.();
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				this.wake = null;
				resolve();
			}, ms);
			this.wake = () => {
				window.clearTimeout(timer);
				this.wake = null;
				resolve();
			};
		});
	}

	private async poll(): Promise<void> {
		let result: Awaited<ReturnType<typeof pollUntilLinked>>;
		try {
			result = await pollUntilLinked(this.opts.client, {
				sleep: (ms) => this.sleep(ms),
				isCancelled: () => this.cancelled,
			});
		} catch (err) {
			console.error('[saive] link poll failed', err);
			this.setStatus('Saive could not check the link. See the developer console, then start again from settings.');
			return;
		}
		switch (result) {
			case 'linked':
				this.close();
				new Notice('Connected to Saive');
				this.opts.onLinked();
				return;
			case 'timeout':
				this.setStatus('The link timed out. Start again from settings.');
				return;
			case 'cancelled':
				return;
		}
	}

	private setStatus(text: string): void {
		if (this.cancelled || this.statusEl === null) return;
		this.statusEl.setText(text);
	}
}
