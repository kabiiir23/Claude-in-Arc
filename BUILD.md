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
| `test-auth-proxy.mjs` | The panel's credentialed claude.ai fetches route through the worker, and nothing else is touched |
| `test-native-guard.mjs` | The install guard is decided by behaviour: broken-but-present native API is replaced, working native is left alone, verdict cached, pages never probe |
| `test-window-mode.mjs` | Detached window mode: one popup, reused and refocused, toggled by the toolbar, cleaned up on switch-back |
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

The guard is **functional, not presence-based**. Arc runs Chromium 152 and does
expose `chrome.tabGroups`, so a presence check stands the emulation down in
favour of an API that cannot group anything without a Chrome tab strip. On
first run the worker probes it on a throwaway background tab and caches the
verdict; a working native API is left alone, a broken one is replaced.

This matters beyond "multi-tab is missing": Claude uses tab groups to obtain a
tab of its own. Without one, every tool targets the user's *active* tab — which
in Arc hosts the injected panel — so navigation destroys the panel and, since
the panel bundle persists no conversation state, reopening starts a new
session.

## Why the auth proxy exists

The panel is an iframe inside an arbitrary page, so a credentialed fetch to
claude.ai takes its site-for-cookies from the **top-level page**, not the
extension. claude.ai's session cookies (`sessionKey`, `sessionKeyV3`,
`lastActiveOrg`) are all `SameSite=Lax`, so they are never sent from that
context: `/api/bootstrap` returns 200 with `account: null`, and the panel shows
"Sign in to Claude" no matter how signed in you are. This is not a
third-party-cookie setting — no browser preference overrides SameSite=Lax.

The service worker has no frame tree, so the same request there is first-party.
`arc/arc-auth-proxy.js` routes only credentialed claude.ai requests through it.
In 1.0.90 that is three calls: `/api/bootstrap` plus two analytics batches.
Everything substantive uses a Bearer token against api.anthropic.com and is left
alone, so streaming is unaffected.

## View modes

`claude_arc_view_mode` in `storage.local` selects how the panel is presented:

| Mode | Behaviour |
|---|---|
| `injected` (default) | iframe in the page, docked to the right, page reflows around it |
| `window` | top-level popup window |

Flip it from the service worker console:

```js
await __arcPanel.setViewMode('window')    // or 'injected'
```

`window` mode exists because an in-page iframe cannot survive a top-level
navigation of its host tab: the document is torn down, and since the panel
persists no conversation state, what reopens is a new session. A popup is a
top-level extension document, so it survives navigation, and being top-level it
also gets first-party cookies without the auth proxy.

There is deliberately no settings UI — adding one means editing Anthropic's
bundle, which is what this repo's structure exists to avoid.

### Why there is no session restore

The panel reads exactly five URL parameters: `mode`, `model`, `q`,
`skipPermissions`, `tabId`. There is no conversation or session parameter, and
`conversationId` does not appear in the panel bundle at all — conversations are
server-side react-query data (`chat_conversation_list`,
`chat_conversation_tree`). Restoring one would mean patching minified React
internals and would break on each upstream release. Keeping the panel alive
(window mode) achieves the same end without that cost.

## Status

- ✅ Phase 0–1: reproducible upstream fetch, patch application, tests
- ✅ Phase 2: tab-group emulation
- ⬜ Phase 3: `browser_batch` and `execute_javascript` handlers; decide which
  CDP-only tools to reimplement on `chrome.scripting`
- ⬜ Phase 4: security fixes carried over from v0.2 — the adapter's
  `execute_script` action and its prefix-matched origin check, permission
  gating for intercepted tools, narrowing `assets/*`, the double-handling race
- ⬜ Phase 5: manual verification in Arc (nothing here has run in a browser yet)
