/**
 * Structural checks on the produced build/<version>/ tree — the things that
 * silently break on an upstream bump and would otherwise only show up as a
 * blank side panel in Arc.
 *
 * Run: node tests/test-build.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildDir, findBundle } from './_bundles.mjs';
import { ARC_SCRIPTS } from '../scripts/arc-scripts.mjs';

const DIR = buildDir();
const read = p => readFileSync(join(DIR, p), 'utf8');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const manifest = JSON.parse(read('manifest.json'));

check('manifest: unpacked build carries no update_url', () => {
  assert.equal(manifest.update_url, undefined);
});

check('manifest: Arc content scripts registered', () => {
  const js = manifest.content_scripts.flatMap(c => c.js);
  assert.ok(js.includes('assets/claude-panel-injector.js'), js.join());
  assert.ok(js.includes('assets/viewport-override.js'), js.join());
  const vp = manifest.content_scripts.find(c => c.js.includes('assets/viewport-override.js'));
  assert.equal(vp.world, 'MAIN', 'viewport override must run in the MAIN world');
  assert.equal(vp.run_at, 'document_start');
});

check('manifest: upstream content scripts preserved', () => {
  const js = manifest.content_scripts.flatMap(c => c.js).join();
  assert.ok(js.includes('accessibility-tree'), 'accessibility tree script missing');
  assert.ok(js.includes('agent-visual-indicator'), 'agent indicator script missing');
});

check('manifest: sidepanel.html is web-accessible', () => {
  const entry = manifest.web_accessible_resources.find(w => w.resources.includes('sidepanel.html'));
  assert.ok(entry, 'no WAR entry exposes sidepanel.html');
  assert.ok(entry.matches.includes('<all_urls>'));
});

check('manifest: no stale declarativeNetRequest ruleset', () => {
  assert.equal(manifest.declarative_net_request, undefined);
  assert.equal(manifest.permissions.includes('declarativeNetRequest'), false);
  assert.equal(existsSync(join(DIR, 'rules.json')), false);
  // The runtime updateSessionRules call needs this one, which upstream declares.
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
});

check('manifest: identity preserved (extension id must stay stable)', () => {
  assert.ok(manifest.key, 'signing key dropped — claude.ai would stop recognising the extension');
  assert.equal(manifest.background.service_worker, 'service-worker-loader.js');
});

check('loader: tab-groups emulation imported before the official worker', () => {
  const lines = read('service-worker-loader.js').trim().split('\n');
  const idx = s => lines.findIndex(l => l.includes(s));
  const official = lines.findIndex(l => l.includes('service-worker.ts-'));
  assert.notEqual(official, -1, 'official worker import not found');
  assert.ok(idx('arc-tabgroups.js') >= 0 && idx('arc-tabgroups.js') < official,
    'arc-tabgroups must precede the official bundle — 1.0.90 reads chrome.tabGroups.Color at module scope');
  assert.ok(idx('arc-sidepanel-shim.js') >= 0 && idx('arc-sidepanel-shim.js') < official,
    'sidePanel polyfill must precede the official bundle');
  assert.ok(idx('arc-bridge-interceptor.js') > official, 'interceptor must load after the worker');
});

check('sidepanel.html: shims run before the module bundle', () => {
  const html = read('sidepanel.html');
  const at = s => html.indexOf(s);
  const mod = at('<script type="module"');
  assert.ok(at('arc-tabgroups.js') > -1 && at('arc-tabgroups.js') < mod);
  assert.ok(at('theme-init.js') > -1 && at('theme-init.js') < mod);
  assert.ok(at('cmd-e-fallback.js') > mod, 'cmd-e fallback belongs at the end of the body');
});

check('options.html / pairing.html: theme override present', () => {
  for (const f of ['options.html', 'pairing.html']) {
    if (!existsSync(join(DIR, f))) continue;
    const html = read(f);
    assert.ok(html.indexOf('theme-init.js') < html.indexOf('<script type="module"'), f);
  }
});

check('every Arc script shipped and parses', () => {
  const present = new Set(readdirSync(join(DIR, 'assets')));
  const missing = ARC_SCRIPTS.filter(f => !present.has(f));
  assert.deepEqual(missing, [], `Arc scripts missing from the build: ${missing}`);
  for (const f of ARC_SCRIPTS) {
    execFileSync(process.execPath, ['--check', join(DIR, 'assets', f)]);
  }
});

check('no leftover no-op tabGroups stub in the sidePanel shim', () => {
  const shim = read('assets/arc-sidepanel-shim.js');
  assert.equal(/chrome\.tabGroups\s*=\s*\{/.test(shim), false,
    'the old stub would race the real emulation depending on import order');
});

check('bridge interceptor still matches the URL the worker builds', () => {
  const worker = findBundle(['bridge.claudeusercontent.com', 'tool_call']);
  const src = readFileSync(worker, 'utf8');
  assert.ok(src.includes('bridge.claudeusercontent.com'), 'bridge host changed upstream');
  const shim = read('assets/arc-sidepanel-shim.js');
  assert.ok(shim.includes('bridge.claudeusercontent.com'), 'shim no longer matches the bridge host');
});

check('intercepted tool names still exist upstream', () => {
  const interceptor = read('assets/arc-bridge-interceptor.js');
  const block = interceptor.slice(interceptor.indexOf('const TOOL_HANDLERS'),
                                  interceptor.indexOf('const INTERCEPTED_TOOL_NAMES'));
  assert.ok(block.length > 100, 'could not locate the TOOL_HANDLERS block');
  const handled = [...block.matchAll(/^\s{2}async (\w+)\(/gm)].map(m => m[1]);
  assert.ok(handled.length >= 5, `parsed ${handled.length} handlers`);
  const tools = findBundle(['tabs_context_mcp', 'get_page_text']);
  const src = readFileSync(tools, 'utf8');
  const missing = handled.filter(t => !src.includes(`"${t}"`));
  assert.deepEqual(missing, [], `intercepted tools no longer in upstream: ${missing} (in ${basename(tools)})`);
});

let failed = 0;
for (const [s, n, m] of results) {
  if (s === 'FAIL') failed++;
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${n}${m ? `\n        ${m}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed (build ${basename(DIR)})`);
process.exit(failed ? 1 : 0);
