/**
 * Detached window mode: the panel as a top-level popup instead of an in-page
 * iframe, so a navigation in the user's tab cannot destroy it.
 *
 * Run: node tests/test-window-mode.mjs
 */
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './_bundles.mjs';

const SRC = join(ROOT, 'arc', 'arc-sidepanel-shim.js');
const HERE = dirname(fileURLToPath(import.meta.url));

const mkEvent = () => {
  const set = new Set();
  return { addListener: f => set.add(f), removeListener: f => set.delete(f), hasListener: f => set.has(f),
           // listeners are async; return their promises so tests can await the effect
           _fire: (...a) => Promise.all([...set].map(f => f(...a))) };
};

let local, session, windows, nextWindowId, created, messagesToTabs, actionClick;

async function loadShim() {
  local = {}; session = {}; windows = new Map(); nextWindowId = 100;
  created = []; messagesToTabs = [];
  actionClick = mkEvent();
  const winRemoved = mkEvent();

  globalThis.self = globalThis;
  delete globalThis.window;
  globalThis.WebSocket = class { constructor() {} send() {} close() {} addEventListener() {} };
  globalThis.chrome = {
    runtime: { id: 'x', getURL: p => 'chrome-extension://x/' + p, lastError: null },
    action: { onClicked: actionClick },
    tabs: {
      async get(id) { return { id, windowId: 1 }; },
      async query() { return []; },
      async sendMessage(tabId, msg) { messagesToTabs.push({ tabId, msg }); return {}; },
      onUpdated: mkEvent(), onRemoved: mkEvent(), onZoomChange: mkEvent()
    },
    windows: {
      async create(opts) { const id = nextWindowId++; windows.set(id, opts); created.push(opts); return { id, ...opts }; },
      async get(id) { if (!windows.has(id)) throw new Error('No window with id'); return { id }; },
      async update(id, p) { return { id, ...p }; },
      async remove(id) { windows.delete(id); },
      onRemoved: winRemoved
    },
    storage: {
      local: { async get(k) { return k in local ? { [k]: local[k] } : {}; }, async set(o) { Object.assign(local, o); }, async remove(k) { delete local[k]; }, onChanged: mkEvent() },
      session: { async get(k) { return k in session ? { [k]: session[k] } : {}; }, async set(o) { Object.assign(session, o); }, async remove(k) { delete session[k]; }, onChanged: mkEvent() }
    },
    sidePanel: undefined,
    tabGroups: { TAB_GROUP_ID_NONE: -1, Color: {}, get: async () => ({}), query: async () => [], update: async () => ({}) },
    debugger: undefined
  };
  chrome.tabs.group = async () => 1;
  chrome.tabs.ungroup = async () => {};

  const tmp = join(HERE, `.win-${Date.now()}-${Math.floor(performance.now() * 1000) % 99999}.mjs`);
  copyFileSync(SRC, tmp);
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
  return { winRemoved };
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

await check('default stays injected: sidePanel.open messages the content script', async () => {
  await loadShim();
  await chrome.sidePanel.open({ tabId: 42 });
  assert.equal(created.length, 0, 'must not open a window in injected mode');
  assert.equal(messagesToTabs.at(-1)?.msg.type, 'SHOW_INJECTED_PANEL');
});

await check('window mode: opens a top-level popup with mode=window', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  await chrome.sidePanel.open({ tabId: 42 });
  assert.equal(messagesToTabs.length, 0, 'must not touch the page in window mode');
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'popup');
  assert.match(created[0].url, /sidepanel\.html\?mode=window&sessionId=session_/);
});

await check('window mode: reuses and focuses one window, never duplicates', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  const a = await self.__arcPanel.openPanelWindow();
  const b = await self.__arcPanel.openPanelWindow();
  assert.equal(a, b, 'second open should focus the existing window');
  assert.equal(created.length, 1, 'exactly one window should ever be created');
});

await check('window mode: a new window opens after the user closes the old one', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  const a = await self.__arcPanel.openPanelWindow();
  await chrome.windows.remove(a);                 // user closed it
  const b = await self.__arcPanel.openPanelWindow();
  assert.notEqual(a, b);
  assert.equal(created.length, 2);
});

await check('window mode: toolbar click toggles the window, not the page', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  await actionClick._fire({ id: 42 });
  assert.equal(created.length, 1, 'first click opens');
  assert.equal(messagesToTabs.length, 0, 'must not message the page');
  await actionClick._fire({ id: 42 });
  assert.equal(windows.size, 0, 'second click closes');
});

await check('switching back to injected closes the window', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  await self.__arcPanel.openPanelWindow();
  assert.equal(windows.size, 1);
  await self.__arcPanel.setViewMode('injected');
  assert.equal(windows.size, 0, 'the popup should not be left orphaned');
  await chrome.sidePanel.open({ tabId: 42 });
  assert.equal(messagesToTabs.at(-1)?.msg.type, 'SHOW_INJECTED_PANEL');
});

await check('setViewMode rejects nonsense', async () => {
  await loadShim();
  await assert.rejects(() => self.__arcPanel.setViewMode('sideways'));
  assert.equal(await self.__arcPanel.getViewMode(), 'injected');
});

await check('view mode persists in storage.local (survives worker restarts)', async () => {
  await loadShim();
  await self.__arcPanel.setViewMode('window');
  assert.equal(local.claude_arc_view_mode, 'window');
});

let failed = 0;
for (const [s, nm, m] of results) {
  if (s === 'FAIL') failed++;
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${nm}${m ? `\n        ${m}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
