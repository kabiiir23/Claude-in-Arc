#!/usr/bin/env node
/**
 * Build the Arc-patched extension: vendor/<version>/ + arc/  ->  build/<version>/
 *
 *   node scripts/apply-patches.mjs           # newest vendored version
 *   node scripts/apply-patches.mjs 1.0.90
 *
 * Every edit is expressed positionally (insert before the first module script,
 * append to a list), never against a chunk filename — upstream renames every
 * hashed asset on each release, so hardcoding names would break every bump.
 * The script fails loudly if an anchor it expects is missing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARC_SCRIPTS, WORKER_IMPORTS } from './arc-scripts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARC_DIR = join(ROOT, 'arc');

const die = msg => { console.error(`✗ ${msg}`); process.exit(1); };

// ─── Resolve version ─────────────────────────────────────────────────────────
const vendorRoot = join(ROOT, 'vendor');
if (!existsSync(vendorRoot)) die('no vendor/ — run ./scripts/fetch-upstream.sh first');

const versions = readdirSync(vendorRoot)
  .filter(d => /^\d+\.\d+\.\d+$/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const version = process.argv[2] || versions.at(-1);
if (!version) die('no vendored versions found');

const SRC = join(vendorRoot, version);
const OUT = join(ROOT, 'build', version);
if (!existsSync(SRC)) die(`vendor/${version} not found (have: ${versions.join(', ') || 'none'})`);

// ─── Stage the build ─────────────────────────────────────────────────────────
// Assembled in a staging directory, then synced into place file-by-file.
// Deleting build/<version> outright would pull the directory out from under a
// loaded unpacked extension — Arc sees the manifest vanish and drops the
// extension, which looks exactly like the patch having broken something.
const STAGE = join(ROOT, 'build', `.staging-${version}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(SRC, STAGE, { recursive: true });
rmSync(join(STAGE, '_metadata'), { recursive: true, force: true });

for (const f of ARC_SCRIPTS) cpSync(join(ARC_DIR, f), join(STAGE, 'assets', f));

const OUT_FINAL = OUT;
const relFiles = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name);
  return e.isDirectory() ? relFiles(p, base) : [p.slice(base.length + 1)];
});

const read = p => readFileSync(join(STAGE, p), 'utf8');
const write = (p, s) => writeFileSync(join(STAGE, p), s);
const notes = [];

// ─── manifest.json ───────────────────────────────────────────────────────────
{
  const m = JSON.parse(read('manifest.json'));

  m.name = 'Claude in Arc';
  m.version_name = `v0.3 (${version})`;
  m.description = 'Claude for Chrome, patched to run in Arc: injected side panel, tab-group emulation, Desktop bridge.';

  // An unpacked extension must not carry an update_url — Arc would try to
  // replace this build with the Web Store one.
  delete m.update_url;

  if (!Array.isArray(m.content_scripts)) die('manifest has no content_scripts');
  m.content_scripts.push(
    { js: ['assets/claude-panel-injector.js'], matches: ['<all_urls>'], run_at: 'document_idle' },
    { js: ['assets/viewport-override.js'], matches: ['<all_urls>'], run_at: 'document_start', world: 'MAIN' }
  );

  // The panel is an iframe of sidepanel.html inside arbitrary pages, so the page
  // and everything it loads has to be web-accessible.
  // TODO(phase-4): narrow this. `assets/*` now exposes 468 files, and the panel
  // dynamically imports ~300 of them (shiki grammars), so an explicit list is
  // impractical — evaluate use_dynamic_url instead.
  if (!Array.isArray(m.web_accessible_resources)) die('manifest has no web_accessible_resources');
  m.web_accessible_resources.push({
    matches: ['<all_urls>'],
    resources: ['sidepanel.html', 'assets/*', 'public/*']
  });

  // system.display: the injector reads display metrics when sizing the panel.
  if (!m.permissions.includes('system.display')) m.permissions.push('system.display');

  // v0.2 added declarativeNetRequest + rules.json to swap four claude.ai chip
  // icons for local copies. 1.0.90 no longer requests those URLs, and the
  // runtime updateSessionRules call is covered by the WithHostAccess permission
  // upstream already declares.
  m.permissions = m.permissions.filter(p => p !== 'declarativeNetRequest');
  delete m.declarative_net_request;
  rmSync(join(STAGE, 'rules.json'), { force: true });

  write('manifest.json', JSON.stringify(m, null, 2) + '\n');
  notes.push(`manifest: ${m.content_scripts.length} content scripts, ${m.permissions.length} permissions`);
}

// ─── service-worker-loader.js ────────────────────────────────────────────────
{
  const src = read('service-worker-loader.js');
  const official = [...src.matchAll(/import\s+['"](.+?)['"]\s*;?/g)].map(m => m[1]);
  if (official.length !== 1) {
    die(`expected exactly 1 import in service-worker-loader.js, found ${official.length}: ${official}`);
  }
  const lines = WORKER_IMPORTS.map(p => `import '${p ?? official[0]}';`);
  write('service-worker-loader.js', lines.join('\n') + '\n');
  notes.push(`worker loader: ${lines.length} imports, official bundle = ${official[0]}`);
}

// ─── HTML pages ──────────────────────────────────────────────────────────────
// theme-init must run before the deferred module bundles paint; cmd-e-fallback
// only matters inside the panel iframe.
function patchHtml(file, { cmdE = false, tabGroups = false, authProxy = false } = {}) {
  let html = read(file);
  const anchor = html.indexOf('<script type="module"');
  if (anchor === -1) die(`${file}: no module <script> to anchor against`);

  const indent = ' '.repeat(4);
  // Classic scripts, so they run during parse — before the deferred module
  // bundles. arc-tabgroups.js has no import/export precisely so it can be
  // loaded this way here and `import`ed by the worker.
  const head = [
    ...(tabGroups ? ['<script src="/assets/arc-tabgroups.js"></script>'] : []),
    ...(authProxy ? ['<script src="/assets/arc-auth-proxy.js"></script>'] : []),
    '<script src="/assets/theme-init.js"></script>'
  ].join(`\n${indent}`);

  html = html.slice(0, anchor) + head + `\n${indent}` + html.slice(anchor);

  if (cmdE) {
    const close = html.lastIndexOf('</body>');
    if (close === -1) die(`${file}: no </body>`);
    html = html.slice(0, close)
         + `  <script src="/assets/cmd-e-fallback.js"></script>\n  `
         + html.slice(close);
  }

  write(file, html);
  notes.push(`${file}: ${[tabGroups && 'arc-tabgroups', authProxy && 'arc-auth-proxy', 'theme-init', cmdE && 'cmd-e-fallback'].filter(Boolean).join(' + ')}`);
}

// The sidepanel bundle calls chrome.tabGroups directly (group titles, loading
// prefixes), so the emulation has to exist in the page context too.
patchHtml('sidepanel.html', { cmdE: true, tabGroups: true, authProxy: true });
patchHtml('options.html');
if (existsSync(join(STAGE, 'pairing.html'))) patchHtml('pairing.html');

// ─── Sync into place ─────────────────────────────────────────────────────────
{
  mkdirSync(OUT_FINAL, { recursive: true });
  const staged = new Set(relFiles(STAGE));

  for (const rel of staged) {
    const src = join(STAGE, rel), dst = join(OUT_FINAL, rel);
    if (existsSync(dst) && statSync(dst).size === statSync(src).size &&
        readFileSync(dst).equals(readFileSync(src))) continue;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }

  let removed = 0;
  if (existsSync(OUT_FINAL)) {
    for (const rel of relFiles(OUT_FINAL)) {
      if (!staged.has(rel)) { rmSync(join(OUT_FINAL, rel), { force: true }); removed++; }
    }
  }
  rmSync(STAGE, { recursive: true, force: true });
  notes.push(`synced in place: ${staged.size} files${removed ? `, ${removed} stale removed` : ''}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────
console.log(`✓ build/${version}`);
for (const n of notes) console.log(`  ${n}`);
console.log(`\nLoad build/${version} as an unpacked extension at arc://extensions`);
