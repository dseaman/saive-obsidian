// The link modal. It shows the six-character code for the hash the plugin
// just sent to the consent page, and runs the link flow (poll /api/sync/me,
// store the secret on approval) until the user approves there. The code is
// the whole point: a phishing page could send a signed-in user to
// /obsidian/connect with an attacker's hash, and the only thing that page
// cannot fake is what this modal shows. So the code is large, first, and
// the instruction says to compare.
//
// Nothing here outlives the modal: the flow reads `cancelled`, closing the
// modal wakes any pending wait so the loop exits at once, and a result that
// lands after the close is dropped.

import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { PollOptions, PollResult } from '../core/link';

export interface LinkModalOptions {
	/** Six characters, or empty when the hash was malformed. */
	code: string;
	url: string;
	/** True when the plugin opened the page itself (desktop). */
	autoOpened: boolean;
	/** Runs the poll-and-store flow with the modal's sleep and cancel hooks. */
	run: (poll: PollOptions) => Promise<PollResult>;
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
		if (this.opts.code === '') {
			contentEl.createEl('p', { text: 'Could not compute the check code. Cancel and try again.' });
			this.actions(contentEl, false);
			return;
		}
		contentEl.createEl('p', {
			text: this.opts.autoOpened
				? 'Approve this vault on the Saive page that just opened. Check that the page shows this code:'
				: 'Open the Saive page below and approve this vault there. Check that the page shows this code:',
		});
		contentEl.createDiv({ cls: 'saive-link-code', text: this.opts.code });
		this.statusEl = contentEl.createEl('p', {
			cls: 'saive-link-status',
			text: 'If the codes differ, close this and start again.',
		});
		this.actions(contentEl, true);
		void this.poll();
	}

	// A real anchor for the consent page: on iOS and Android the WebView
	// needs a user gesture on the link itself, which window.open after an
	// await does not count as. Desktop gets the same link as a second try.
	private actions(contentEl: HTMLElement, withLink: boolean): void {
		const row = contentEl.createDiv({ cls: 'saive-link-actions' });
		if (withLink) {
			row.createEl('a', {
				text: this.opts.autoOpened ? 'Open the page again' : 'Open the Saive page',
				href: this.opts.url,
				cls: 'saive-link-open',
				attr: { target: '_blank', rel: 'noopener' },
			});
		}
		row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
			this.close();
		});
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
		let result: PollResult;
		try {
			result = await this.opts.run({
				sleep: (ms) => this.sleep(ms),
				isCancelled: () => this.cancelled,
			});
		} catch (err) {
			if (this.cancelled) return;
			console.error('[saive] link failed', err);
			this.setStatus('Saive could not check the link. See the developer console, then start again from settings.');
			return;
		}
		// Closed while the last request was in flight: nothing to announce.
		if (this.cancelled) return;
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
