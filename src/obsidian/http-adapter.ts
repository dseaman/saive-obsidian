// HttpPort over Obsidian's requestUrl, which skips CORS and works on
// mobile. GET only: this plugin never writes to Saive. `throw: false` hands
// 4xx and 5xx back as responses so the client can map them to typed errors.

import { requestUrl } from 'obsidian';
import type { HttpPort, HttpResponse } from '../core/ports';

export class ObsidianHttp implements HttpPort {
	async get(url: string, headers: Record<string, string>): Promise<HttpResponse> {
		const res = await requestUrl({ url, method: 'GET', headers, throw: false });
		return { status: res.status, headers: res.headers, text: res.text };
	}
}
