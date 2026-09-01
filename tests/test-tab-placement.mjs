/**
 * Work tabs should open in the current window (so they land in the Space you
 * are using), while every panel window must stay a real window.
 *
 * Run: node tests/test-tab-placement.mjs
 */
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './_bundles.mjs';

const SRC = join(ROOT, 'arc', 'arc-tab-placement.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/';

let realWindows, createdTabs, local, lastFocusedFails;
let n = 0;

async function load({ isWorker = true, hasNormalWindow = true } = {}) {
  realWindows = []; createdTabs = []; local = {}; lastFocusedFails = false;
  let nextTab = 1;

  delete globalThis.__arcTabPlacement;   // globals leak between loads in one process
  if (isWorker) delete globalThis.window; else globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.chrome = {
    runtime: { id: 'x', getURL: p => EXT + p },
    windows: {
      async create(opts) { realWindows.push(opts); return { id: 900, ...opts, tabs: [{ id: 999 }] }; },
      async getLastFocused() {
        if (lastFocusedFails) throw new Error('no window');
        return hasNormalWindow ? { id: 1, type: 'normal' } : undefined;
      }
    },
    tabs: {
      async create(p) { const t = { id: nextTab++, ...p }; createdTabs.push(t); return t; }
    },
    storage: { local: { async get(k) { return k in local ? { [k]: local[k] } : {}; }, async set(o) { Object.assign(local, o); } } }
  };

  const tmp = join(HERE, `.place-${Date.now()}-${n++}.mjs`);
  copyFileSync(SRC, tmp);
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

await check("type:'normal' work window becomes a tab in the current window", async () => {
  await load();
  const r = await chrome.windows.create({ url: 'chrome://newtab', focused: true, type: 'normal' });
  assert.equal(realWindows.length, 0, 'no new Arc window should be opened');
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].windowId, 1);
  assert.equal(r.tabs[0].id, createdTabs[0].id, 'callers read .tabs[0].id');
  assert.equal(r.id, 1);
});

await check('untyped work window is redirected too (type defaults to normal)', async () => {
  await load();
  await chrome.windows.create({ url: 'https://example.com' });
  assert.equal(realWindows.length, 0);
  assert.equal(createdTabs.length, 1);
});

await check("type:'popup' panels stay real windows", async () => {
  await load();
  await chrome.windows.create({ url: EXT + 'sidepanel.html?mode=window', type: 'popup', width: 500 });
  assert.equal(realWindows.length, 1, 'the detached panel must remain a window');
  assert.equal(createdTabs.length, 0);
});

await check('untyped extension-origin window stays a real window', async () => {
  // Upstream opens sidepanel.html with no `type`, which defaults to normal —
  // redirecting that would turn the panel into a tab.
  await load();
  await chrome.windows.create({ url: EXT + 'sidepanel.html?tabId=7' });
  assert.equal(realWindows.length, 1, 'extension pages are panels, not work');
  assert.equal(createdTabs.length, 0);
});

await check('multiple urls all land in the current window, first one active', async () => {
  await load();
  const r = await chrome.windows.create({ url: ['https://a.test', 'https://b.test'], focused: true });
  assert.equal(createdTabs.length, 2);
  assert.deepEqual(createdTabs.map(t => t.active), [true, false]);
  assert.equal(r.tabs.length, 2);
});

await check('focused:false does not steal focus', async () => {
  await load();
  await chrome.windows.create({ url: 'chrome://newtab/', focused: false, type: 'normal' });
  assert.equal(createdTabs[0].active, false);
});

await check("'new-window' setting restores upstream behaviour", async () => {
  await load();
  await self.__arcTabPlacement.set('new-window');
  await chrome.windows.create({ url: 'chrome://newtab', type: 'normal' });
  assert.equal(realWindows.length, 1, 'should fall through to a real window');
  assert.equal(createdTabs.length, 0);
});

await check('falls back to a real window when there is none to place into', async () => {
  await load({ hasNormalWindow: false });
  await chrome.windows.create({ url: 'chrome://newtab', type: 'normal' });
  assert.equal(realWindows.length, 1);
});

await check('falls back when getLastFocused throws', async () => {
  await load();
  lastFocusedFails = true;
  await chrome.windows.create({ url: 'chrome://newtab', type: 'normal' });
  assert.equal(realWindows.length, 1);
});

await check('page contexts are not patched', async () => {
  await load({ isWorker: false });
  await chrome.windows.create({ url: 'chrome://newtab', type: 'normal' });
  assert.equal(realWindows.length, 1, 'only the worker should redirect placement');
  assert.equal(globalThis.self.__arcTabPlacement, undefined);
  delete globalThis.window;
});

await check('set() rejects nonsense', async () => {
  await load();
  await assert.rejects(() => self.__arcTabPlacement.set('elsewhere'));
});

let failed = 0;
for (const [s, nm, m] of results) {
  if (s === 'FAIL') failed++;
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${nm}${m ? `\n        ${m}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
