# Saive Sync for Obsidian

Sync your [Saive](https://saive.my/?utm_source=obsidian-plugin) library into your Obsidian vault.

Saive saves the articles, videos, recipes and papers you find on the web as Markdown files, with a summary, tags and your highlights. This plugin copies those files into a folder in your vault and keeps them current, so your saves show up in search, backlinks and the graph next to your own notes.

> **Status: pre-release.** Version 0.0.1 proves the build and release pipeline and does nothing else. Sync and the account link are on `main` and ship in the next release. The plugin is absent from the community directory until then.

## How syncing works

- **Connect once.** Choose **Connect account** in the plugin's settings. The plugin generates a secret token, keeps it in Obsidian's secret storage, and opens a Saive page in your browser that carries a hash of the token and your vault's name. Obsidian and the page both show a six-character code derived from that hash; approve on the page when the two match. The page never sees the token and the plugin never sees your password.
- **One way, Saive to Obsidian.** The plugin reads your library and writes notes into a folder you choose (default `Saive/`). It never sends your notes, your edits or any other vault content to Saive.
- **The files are yours.** Each note holds the same Markdown and frontmatter Saive stores, byte for byte. Remove the plugin and the notes stay.
- **Your edits survive.** If you edit the body of a synced note and the save later changes in Saive, the plugin keeps a copy of your version in `Saive/_conflicts/` before it updates the note.
- **Deletes stay safe.** A save you delete in Saive moves to Obsidian's trash, and the plugin asks first when one sync would trash many notes. A note you delete in Obsidian stays gone until you run **Full resync**.
- **Desktop and mobile.** Automatic sync is a per-device choice: off, every 15 minutes, or every hour. **Sync now** runs at any time.

## Disclosures

Obsidian's developer policies ask every plugin to state these in plain view.

- **Account required.** You need a Saive account, which you can get free at [Saive.my](https://saive.my/?utm_source=obsidian-plugin).
- **Network use.** The plugin talks to one host, `app.saive.my`, over HTTPS, with GET requests alone: `GET /api/sync/me` (is this device connected), `GET /api/sync/pull` (changed saves since the last sync), `GET /api/sync/file/<uuid>` (one large save), `GET /api/sync/manifest` (the list of saves, for a full resync). Each request carries the read-only token and the plugin version. When you connect, your browser opens `app.saive.my/obsidian/connect` with a hash of the token and the name of your vault, so you can recognise the request. Nothing else leaves your vault.
- **Read-only access.** The token the plugin holds can read your library, private saves included. It cannot add, change or delete anything in Saive. **Disconnect** in the plugin's settings forgets the token on that device; to revoke it, remove the vault from your account settings at `app.saive.my`. The plugin keeps the token in Obsidian's secret storage, never in `data.json`, so a vault you publish or sync does not carry it.
- **Server-side records.** Saive's server records the time of each sync and the plugin version that asked, to count active installs and to debug sync problems. The plugin itself collects no analytics and contains no tracking code. See the [privacy policy](https://saive.my/privacy).
- **Closed-source service.** This plugin is open source under the MIT license. The Saive service it connects to is a hosted, closed-source product.
- **Payments.** The plugin is free. Saive has a free tier.

## Install the pre-release

1. Install the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin.
2. In BRAT, choose **Add beta plugin** and enter `dseaman/saive-obsidian`.

Requires Obsidian 1.11.4 or later.

## Development

```sh
npm ci
npm run dev                 # watch build into main.js
npm test                    # vitest
npm run lint                # eslint with Obsidian's rules
npm run build               # typecheck + production build
npm run check:reproducible  # two builds, same bytes
```

To try a build, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/saive/` and enable the plugin.

`contracts/obsidian-sync-v1.json` is a copy of the wire contract the Saive server tests against. Changes start on the server side.

## Support

This README is the plugin's documentation, and **How syncing works** above is what the settings tab links to. Open an [issue](https://github.com/dseaman/saive-obsidian/issues) or write to dan.seaman@gmail.com.

## License

MIT
