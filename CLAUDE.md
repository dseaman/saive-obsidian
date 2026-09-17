# saive-obsidian

The Saive plugin for Obsidian: a one-way mirror of a user's Saive library into their vault. Public repo, MIT. TypeScript, esbuild, vitest, npm, Node 24. Built from `obsidianmd/obsidian-sample-plugin`.

The Saive server lives in a separate private monorepo (`dseaman/saive`, checked out at `~/Code/saive`). This repo shares no code with it. The plan of record is `docs/plans/sv-1r1w-obsidian-plugin.md` over there; read it before any feature work.

## Non-negotiable rules

1. **Read-only client.** Saive's storage is the source of truth. Every request is a GET through Obsidian's `requestUrl`. No POST, PUT, PATCH or DELETE, and no `fetch` (it fails CORS).
2. **The token never touches `data.json`.** The `sv_obs_` secret lives in `app.secretStorage`. Users commit `.obsidian/` to public git, and the token reads a whole private library. `minAppVersion` stays at 1.11.4 or later for that reason.
3. **Byte-faithful files.** Write the `markdown` field from the server as-is. No trimming, no line-ending changes, no frontmatter rewrites.
4. **The contract is frozen upstream.** `contracts/obsidian-sync-v1.json` is a copy of `docs/contracts/obsidian-sync-v1.json` in the Saive monorepo. Change it there first, bump `version`, then copy it here. Never edit the copy alone.
5. **No Node or Electron APIs in `src/`** outside test files. The plugin runs on iOS and Android.
6. **Reproducible build.** Obsidian's review rebuilds `main.js` from source and compares. No timestamps, git SHAs or environment reads in the build. `esbuild` stays pinned to an exact version.
7. **No client-side telemetry.** Obsidian's developer policies ban it. The README discloses the server-side sync records; keep that section true.

## Layout

- `src/main.ts`: plugin entry. Obsidian imports stay at the edge: sync logic goes in pure modules that vitest can run without Obsidian.
- `src/core/`: the pure sync core. `contract.ts` (types and guards for the wire contract, `compareSeq`), `filename.ts` (`sanitizeTitle`, `buildPath`), `hash.ts` (`fullHash`, `bodyHash`, `sha256Hex`), `link-code.ts` (the check-code port), `plan.ts` (`planPage`: one page of changes in, actions and the next state out). Nothing in this directory imports `obsidian`.
- `src/**/*.test.ts`: vitest, node environment.
- `contracts/`: the frozen wire contract.
- `scripts/check-reproducible.mjs`: builds twice and compares hashes.
- `.github/workflows/ci.yml`: lint, build, test, reproducibility on every PR.
- `.github/workflows/release.yml`: a bare `x.y.z` tag builds and publishes a release with `main.js` and `manifest.json`. The tag must equal `manifest.json`'s version.

## Commands

- `npm ci`, `npm run dev`, `npm test`, `npm run lint`, `npm run build`, `npm run check:reproducible`
- Release: `npm version patch` (bumps `package.json`, `manifest.json`, `versions.json` and creates a bare tag), then push the commit and the tag. Ask Dan before pushing any tag: a tag publishes a public release.

## Obsidian review rules that bite

`this.app`, never the global `app`. No `innerHTML`. Sentence case in UI text. `setHeading()` for settings headings, and no "settings" in a heading. No default hotkeys. Command IDs without the plugin id. `vault.process` for background file edits, `fileManager.trashFile` for deletes, `fileManager.renameFile` for moves, `normalizePath` on every user-supplied path. Register every interval and event so unload cleans up. The status bar does not exist on mobile. `eslint-plugin-obsidianmd` enforces part of this list; the rest needs eyes.

## Workflow

- Branch, PR, squash-merge. Dan merges. Never push to `main`, never force-push, never push a tag without asking.
- Issues are tracked in the Saive monorepo's beads tracker (`bd`, epic `sv-1r1w`, label `obsidian`), by PR link. GitHub Issues on this repo is the public inbox.
- Tests first. A test must go through the same entry point production uses; confirm a new test can fail by reintroducing the fault once.

## Writing

Every piece of prose (README, PR bodies, commit messages, UI copy) follows these rules: no em dashes, no adverbs, active voice with a person or a named component as the subject, no throat-clearing openers, no "not X, it's Y" contrasts, specific claims over vague ones, varied sentence length. Code comments are exempt.
