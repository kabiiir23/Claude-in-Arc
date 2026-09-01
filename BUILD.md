# Building Claude in Arc (v1.0.90 branch)

Upstream is fetched, not vendored. The repo holds only the Arc patches, so
tracking a new Claude for Chrome release is a re-run rather than a re-port, and
the entire delta against Anthropic's code is readable in one directory.

```bash
./scripts/fetch-upstream.sh          # Web Store CRX -> vendor/<version>/
node scripts/apply-patches.mjs       # + arc/        -> build/<version>/
./scripts/test.sh
```

Then load `build/<version>/` as an unpacked extension at `arc://extensions`.

`vendor/` and `build/` are gitignored. `UPSTREAM.txt` records the version and
CRX SHA-256 of every fetch.

## Layout

| Path | What |
|---|---|
| `arc/` | The nine patch scripts. This is the whole delta. |
| `scripts/arc-scripts.mjs` | Script list + worker import order — single source of truth |
| `scripts/fetch-upstream.sh` | Downloads and unpacks the official CRX |
| `scripts/apply-patches.mjs` | Applies the patches; fails loudly if an anchor moved |
| `tests/` | Four harnesses, run with `./scripts/test.sh` |

## What the patcher changes

Nothing is matched by chunk filename — upstream re-hashes every asset each
release. Edits anchor on structure (first module `<script>`, the single import
in the worker loader, list append) and the script aborts if an anchor is gone.

- **manifest** — name/description, drops `update_url` (an unpacked build must
  not self-update), adds the two Arc content scripts, adds a
  `web_accessible_resources` entry for `sidepanel.html`, adds `system.display`,
  drops the now-dead `declarativeNetRequest` ruleset.
- **service-worker-loader.js** — wraps the single official import with the five
  Arc modules, in the order `arc-scripts.mjs` defines.
- **sidepanel.html / options.html / pairing.html** — `theme-init.js` before the
  module bundles, `cmd-e-fallback.js` at the end of the panel body, and
  `arc-tabgroups.js` in the panel (its bundle calls `chrome.tabGroups` directly).

## Tests

| Harness | Asserts |
|---|---|
| `test-build.mjs` | Build invariants: load order, manifest deltas, every Arc script present and parsing, intercepted tool names still exist upstream |
| `test-arc-tabgroups.mjs` | 22 tab-group sequences transcribed from the upstream bundle |
| `test-real-manager.mjs` | Upstream's own `TabGroupManager`, driven live against the shim |
| `test-v02-stub.mjs` | Control: the same upstream code on v0.2's no-op stub, which fails 9 of 11. Passes when it observes that breakage — it exists to justify the shim. |

Harnesses locate bundles by content, so they survive version bumps.

## Why the tab-group emulation exists

1.0.90 uses Chrome tab groups as its tool-session scoping primitive, and reads
`chrome.tabGroups.Color` at **module scope**:

```js
static SESSION_GROUP_COLORS = [chrome.tabGroups.Color.BLUE, /* … */]
```

On a browser with no `chrome.tabGroups`, the service worker throws on startup —
the extension does not merely lose features, it fails to boot. v0.2's no-op stub
avoided the crash but left every tool failing with *"no tab group exists for this
session"*. `arc/arc-tabgroups.js` keeps a real registry in `storage.session`
instead, shared across the worker and the panel.

It no-ops if a native `chrome.tabGroups` is present, so it is safe if Arc ever
ships the API.

## Status

- ✅ Phase 0–1: reproducible upstream fetch, patch application, tests
- ✅ Phase 2: tab-group emulation
- ⬜ Phase 3: `browser_batch` and `execute_javascript` handlers; decide which
  CDP-only tools to reimplement on `chrome.scripting`
- ⬜ Phase 4: security fixes carried over from v0.2 — the adapter's
  `execute_script` action and its prefix-matched origin check, permission
  gating for intercepted tools, narrowing `assets/*`, the double-handling race
- ⬜ Phase 5: manual verification in Arc (nothing here has run in a browser yet)
