# Inbox Cleaner — working notes for Claude

## Workflow

**Automatically merge after completing edits.** Once a change is finished and
verified, don't stop at "pushed, ready for review" — open the pull request,
merge it to `main`, and say so. No approval round-trip is expected for routine
work in this repo.

Order of operations:

1. Commit the work on the feature branch and push it.
2. Open a PR describing the change.
3. Merge it (squash) as soon as checks pass.
4. Report what was merged and what it does.

A merge is a release: `main` deploys through Cloudflare's Git integration
(`wrangler.toml` serves the repo as the Worker's static assets), not through
GitHub Actions — there is no CI workflow to wait on. Bump `APP_VERSION` in
`index.html` with every user-visible change; it's shown in Settings and is how
a running build gets identified.

Ask first (don't auto-merge) when a change would touch OAuth/auth flow, delete
user data, or when the task itself was ambiguous enough that the wrong reading
would be expensive to undo.

## Layout

The app is a single-file PWA. There is no build step — edit and ship.

- `index.html` — the whole app: markup, CSS, and the inline `<script>` holding
  all state and logic. ~4,300 lines.
- `sw.js` — service worker, network-first so a reload always gets fresh code.
- `worker.js` — Cloudflare Worker backing the OAuth auth-code / refresh-token
  flow (see `AUTH-SETUP.md`).
- `manifest.json`, `icon-*.png` — PWA install metadata.

## Conventions

- Vanilla JS only. No frameworks, no bundler, no npm dependencies.
- State lives in module-scoped `let` bindings at the top of the script; the
  section banner comments (`// ── State ───`) mark the boundaries — keep new
  code in the section it belongs to.
- Per-account data is namespaced through `nsKey(base)` (keep list, deck,
  outbox, sender stats, sender rules). App-wide preferences use plain
  `localStorage` keys. Wrap every `localStorage` access in try/catch — Safari
  private mode throws.
- Every Gmail write should have an offline path: attempt it, and on failure
  `enqueueOp(...)` so `flushOutbox()` retries on reconnect.
- Escape anything user- or mail-derived with `esc()` before it reaches
  `innerHTML`.
- Settings follow a `loadX()` / `setX(value)` pair; call `loadX()` from the
  init block at the bottom of the script.

## Verifying a change

There's no test suite. Before merging, serve the directory and drive it in a
headless browser:

```sh
npx http-server . -p 8099 -s
```

Then exercise the changed functions in page context (the app's functions are
all global), or force past the auth screen to screenshot a tab:

```js
document.getElementById('auth-screen').style.display = 'none';
document.getElementById('main-wrapper').style.display = 'flex';
switchTab('bulk');
```

Check both colour schemes — the CSS has a `prefers-color-scheme: dark` block.
