/**
 * The install guard must be decided by behaviour, not by presence.
 *
 * Arc runs Chromium 152 and exposes chrome.tabGroups, so a presence check
 * stands the emulation down. If that native API cannot actually group tabs,
 * Claude never gets a session tab and every tool lands on the user's active
 * tab — the one hosting the injected panel, which navigation then destroys.
 *
 * Run: node tests/test-native-guard.mjs
 */
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shimPath } from './_bundles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
async function loadFresh() {
  const tmp = join(HERE, `.guard-${Date.now()}-${n++}.mjs`);
  copyFileSync(shimPath(), tmp);
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
}

const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const settle = () => new Promise(r => setTimeout(r, 10));

/**
 * @param native 'none' | 'working' | 'broken'
 */
function makeChrome(native, { local = {} } = {}) {
  const tabs = new Map();
  const members = new Map();
  let nextTab = 1, nextGroup = 7000;
  let probeTabsCreated = 0;

  const c = {
    runtime: { id: 'x' },
    tabs: {
      async get(id) { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t, groupId: members.get(id) ?? -1 }; },
      async query(q = {}) {
        let out = [...tabs.values()].map(t => ({ ...t, groupId: members.get(t.id) ?? -1 }));
        if (native === 'none' && 'groupId' in q) throw new Error('Arc: groupId unsupported');
        if ('groupId' in q) out = out.filter(t => t.groupId === q.groupId);
        return out;
      },
      async create(p = {}) { probeTabsCreated++; const t = { id: nextTab++, windowId: 1, url: p.url, title: '' }; tabs.set(t.id, t); return { ...t }; },
      async remove(id) { for (const i of [].concat(id)) { tabs.delete(i); members.delete(i); } },
      onRemoved: ev(), onUpdated: ev()
    },
    storage: {
      local: { async get(k) { return k in local ? { [k]: local[k] } : {}; }, async set(o) { Object.assign(local, o); }, async remove(k) { delete local[k]; } },
      session: { async get() { return {}; }, async set() {}, onChanged: ev() }
    },
    get probeTabs() { return probeTabsCreated; }
  };

  if (native === 'working') {
    c.tabGroups = {
      TAB_GROUP_ID_NONE: -1, Color: { BLUE: 'blue' },
      async get(id) { if (![...members.values()].includes(id)) throw new Error('no group'); return { id, title: '', color: 'blue', windowId: 1 }; },
      async query() { return []; }, async update(id) { return { id }; }
    };
    c.tabs.group = async ({ tabIds }) => { const g = nextGroup++; [].concat(tabIds).forEach(t => members.set(t, g)); return g; };
    c.tabs.ungroup = async ids => { [].concat(ids).forEach(t => members.delete(t)); };
  } else if (native === 'broken') {
    // The realistic Arc shape: the API exists, grouping silently does nothing.
    c.tabGroups = {
      TAB_GROUP_ID_NONE: -1, Color: { BLUE: 'blue' },
      async get() { throw new Error('No group with id'); },
      async query() { return []; }, async update() { return {}; }
    };
    c.tabs.group = async () => -1;
    c.tabs.ungroup = async () => {};
  }
  return c;
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

await check('no native API: emulation installs immediately', async () => {
  delete globalThis.window;
  globalThis.chrome = makeChrome('none');
  await loadFresh();
  assert.equal(chrome.tabGroups.__arcEmulated, true);
  assert.equal(typeof chrome.tabs.group, 'function');
});

await check('native present but broken: emulation takes over after the probe', async () => {
  delete globalThis.window;
  const c = makeChrome('broken');
  globalThis.chrome = c;
  await loadFresh();
  await settle();   // the probe is async; only the settled state is meaningful
  assert.equal(chrome.tabGroups.__arcEmulated, true, 'broken native must be replaced by the emulation');
  assert.equal(await chrome.tabs.group({ tabIds: [1] }) >= 1000, true, 'emulated ids should be in use');
});

await check('native that works is left alone', async () => {
  delete globalThis.window;
  globalThis.chrome = makeChrome('working');
  await loadFresh();
  await settle();
  assert.notEqual(chrome.tabGroups.__arcEmulated, true, 'a working native API must not be replaced');
});

await check('probe verdict is cached (one throwaway tab per install)', async () => {
  delete globalThis.window;
  const local = {};
  const c1 = makeChrome('broken', { local });
  globalThis.chrome = c1;
  await loadFresh();
  await settle();
  assert.equal(local.claude_arc_native_tabgroups_ok, false, 'verdict should be persisted');
  const firstRun = c1.probeTabs;
  assert.ok(firstRun >= 1, 'first run must actually probe');

  const c2 = makeChrome('broken', { local });   // same cache, fresh worker
  globalThis.chrome = c2;
  await loadFresh();
  await settle();
  assert.equal(c2.probeTabs, 0, 'cached verdict must skip the probe');
  assert.equal(chrome.tabGroups.__arcEmulated, true, 'cached "broken" must still install the emulation');
});

await check('page contexts never spawn a probe tab', async () => {
  const local = {};
  globalThis.window = globalThis;
  const c = makeChrome('broken', { local });
  globalThis.chrome = c;
  await loadFresh();
  await settle();
  assert.equal(c.probeTabs, 0, 'only the service worker may open a probe tab');
  delete globalThis.window;
});

await check('page context honours a cached "broken" verdict', async () => {
  const local = { claude_arc_native_tabgroups_ok: false };
  globalThis.window = globalThis;
  globalThis.chrome = makeChrome('broken', { local });
  await loadFresh();
  await settle();
  assert.equal(chrome.tabGroups.__arcEmulated, true, 'panel must match the worker implementation');
  delete globalThis.window;
});

let failed = 0;
for (const [s, nm, m] of results) {
  if (s === 'FAIL') failed++;
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${nm}${m ? `\n        ${m}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
