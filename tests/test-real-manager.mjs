/**
 * The decisive spike: drive Claude 1.0.90's REAL TabGroupManager (export `Gt`
 * of assets/mcpPermissions-BIFqj2d3.js, 504 KB minified) against a fake Arc
 * chrome API with the tab-groups shim installed.
 *
 * Nothing here is transcribed. Every group operation is Anthropic's own code.
 *
 * Run: node test-real-manager.mjs
 */
import assert from 'node:assert/strict';
import { shimPath, tabGroupBundle } from './_bundles.mjs';

const ev = () => { const s = new Set(); return {
  addListener: f => s.add(f), removeListener: f => s.delete(f), hasListener: f => s.has(f),
  _fire: (...a) => { for (const f of [...s]) { try { f(...a); } catch (e) {} } } }; };

let nextTabId = 1, nextWinId = 1;
const tabs = new Map();
const local = {}, session = {};

const chromeStub = {
  runtime: { id: 'spike', lastError: null, getManifest: () => ({ version: '1.0.90' }),
             getURL: p => 'chrome-extension://x/' + p, onMessage: ev(), onInstalled: ev(), onConnect: ev() },
  tabs: {
    async get(id) { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return { ...t }; },
    async query(q = {}) {
      assert.equal('groupId' in q, false, 'groupId leaked to the real tabs.query');
      let out = [...tabs.values()];
      if (q.windowId !== undefined) out = out.filter(t => t.windowId === q.windowId);
      if (q.active !== undefined) out = out.filter(t => t.active === q.active);
      if (q.currentWindow !== undefined) out = out.filter(t => t.windowId === 1);
      return out.map(t => ({ ...t }));
    },
    async create(p = {}) {
      const t = { id: nextTabId++, windowId: p.windowId ?? 1, url: p.url ?? 'about:blank',
                  title: 'New Tab', active: p.active !== false, index: tabs.size };
      tabs.set(t.id, t); return { ...t };
    },
    async update(id, p) { const t = tabs.get(id); if (t) Object.assign(t, p); return { ...t }; },
    async remove(ids) { for (const id of [].concat(ids)) { tabs.delete(id); chromeStub.tabs.onRemoved._fire(id, {}); } },
    async sendMessage() { return {}; },
    onUpdated: ev(), onRemoved: ev(), onActivated: ev(), onCreated: ev(),
    onAttached: ev(), onDetached: ev(), onMoved: ev(), onReplaced: ev(), onZoomChange: ev()
  },
  windows: {
    async get(id) { return { id, state: 'normal' }; },
    async getLastFocused() { return { id: 1, state: 'normal' }; },
    async create(p = {}) {
      const id = ++nextWinId;
      const t = await chromeStub.tabs.create({ windowId: id, url: p.url });
      return { id, tabs: [t] };
    },
    async update(id, p) { return { id, ...p }; },
    onCreated: ev(), onRemoved: ev(), onFocusChanged: ev()
  },
  storage: {
    local:   { async get(k) { return typeof k === 'string' ? (k in local ? { [k]: local[k] } : {}) : { ...local }; },
               async set(o) { Object.assign(local, o); }, async remove(k) { delete local[k]; }, onChanged: ev() },
    session: { async get(k) { return typeof k === 'string' ? (k in session ? { [k]: session[k] } : {}) : { ...session }; },
               async set(o) { Object.assign(session, o); }, async remove(k) { delete session[k]; },
               async setAccessLevel() {}, onChanged: ev() },
    onChanged: ev()
  },
  scripting: { async executeScript() { return [{ result: '' }] } },
  permissions: { async contains() { return true }, onAdded: ev(), onRemoved: ev() },
  action: { onClicked: ev() }, alarms: { create() {}, onAlarm: ev() },
  i18n: { getUILanguage: () => 'en-US', getMessage: () => '' }
};

globalThis.self = globalThis;
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Chrome/140', platform: 'MacIntel', language: 'en-US' }, configurable: true }); } catch {}
try { Object.defineProperty(globalThis, 'location', { value: new URL('chrome-extension://x/sw.js'), configurable: true }); } catch {}
globalThis.WebSocket = class { constructor() { this.readyState = 0 } send() {} close() {} addEventListener() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });
globalThis.addEventListener = () => {};

globalThis.chrome = chromeStub;
await import(shimPath());           // ← the shim under test
const SHIM = chromeStub.tabGroups;

// Fill in only the unrelated APIs the bundle happens to touch.
const auto = () => new Proxy(function () {}, {
  get(t, k) { if (k === 'then') return undefined;
    if (k === 'addListener' || k === 'removeListener') return () => {};
    if (k === 'hasListener') return () => false;
    if (!(k in t)) t[k] = auto(); return t[k]; },
  apply() { return Promise.resolve({}); } });
const wrap = (o, path = 'chrome') => new Proxy(o, {
  get(t, k) { if (typeof k === 'symbol' || k === 'then') return t[k];
    if (!(k in t)) t[k] = auto();
    const v = t[k]; if (v === SHIM) return v;
    return (v && typeof v === 'object' && !Array.isArray(v)) ? wrap(v, path + '.' + String(k)) : v; } });
globalThis.chrome = wrap(chromeStub);

assert.equal(chrome.tabGroups, SHIM, 'shim must be the live tabGroups implementation');

const M = await import(tabGroupBundle());
const mgr = M.Gt;   // the real TabGroupManager singleton
assert.equal(typeof mgr.createGroup, 'function');

function freshTab(url = 'https://example.com') {
  const t = { id: nextTabId++, windowId: 1, url, title: 'Example', active: true, index: tabs.size };
  tabs.set(t.id, t); return t.id;
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.stack?.split('\n').slice(0, 2).join(' | ') || e.message]); }
};

await check('real manager: initialize()', async () => {
  await mgr.initialize();
});

let mainTab, groupId;
await check('real manager: createGroup() allocates a group', async () => {
  mainTab = freshTab();
  const g = await mgr.createGroup(mainTab);
  groupId = g.chromeGroupId;
  assert.equal(typeof groupId, 'number');
  assert.equal(g.mainTabId, mainTab);
  assert.equal((await chrome.tabs.get(mainTab)).groupId, groupId);
});

await check('real manager: group got a title and colour', async () => {
  const meta = await chrome.tabGroups.get(groupId);
  assert.ok(meta.title, `expected a title, got ${JSON.stringify(meta)}`);
  assert.ok(Object.values(chrome.tabGroups.Color).includes(meta.color));
});

await check('real manager: findGroupByMainTab() round-trips', async () => {
  const found = await mgr.findGroupByMainTab(mainTab);
  assert.ok(found, 'group not found');
  assert.equal(found.chromeGroupId, groupId);
});

await check('real manager: addTabToGroup() extends membership', async () => {
  const extra = freshTab('https://second.example');
  await mgr.addTabToGroup(mainTab, extra);
  const members = await chrome.tabs.query({ groupId });
  assert.deepEqual(members.map(t => t.id).sort((a, b) => a - b), [mainTab, extra].sort((a, b) => a - b));
});

await check('real manager: isTabInSameGroup() agrees', async () => {
  const members = (await chrome.tabs.query({ groupId })).map(t => t.id);
  assert.equal(await mgr.isTabInSameGroup(members[0], members[1]), true);
  assert.equal(await mgr.isTabInSameGroup(members[0], freshTab()), false);
});

await check('real manager: getGroupDetails() lists members', async () => {
  const d = await mgr.getGroupDetails(mainTab);
  assert.ok(d, 'no details');
  assert.equal(d.memberTabs.length, 2);
});

let mcpCtx;
await check('real manager: getOrCreateMcpTabContext({createIfEmpty:true})', async () => {
  mcpCtx = await mgr.getOrCreateMcpTabContext({ createIfEmpty: true });
  assert.ok(mcpCtx, 'no MCP context returned');
  assert.equal(typeof mcpCtx.tabGroupId, 'number');
  assert.ok(mcpCtx.tabCount >= 1);
});

await check('real manager: MCP context is reused on the next call', async () => {
  const again = await mgr.getOrCreateMcpTabContext({ createIfEmpty: false });
  assert.ok(again, 'context not reused');
  assert.equal(again.tabGroupId, mcpCtx.tabGroupId);
});

await check('real manager: recreates context after its tabs are closed', async () => {
  for (const t of await chrome.tabs.query({ groupId: mcpCtx.tabGroupId })) await chrome.tabs.remove(t.id);
  await new Promise(r => setImmediate(r));
  const empty = await mgr.getOrCreateMcpTabContext({ createIfEmpty: false });
  assert.ok(!empty || empty.tabCount === 0, `expected no context, got ${JSON.stringify(empty)}`);
  const rebuilt = await mgr.getOrCreateMcpTabContext({ createIfEmpty: true });
  assert.ok(rebuilt.tabGroupId);
  assert.notEqual(rebuilt.tabGroupId, mcpCtx.tabGroupId);
});

await check('real manager: getValidTabIds() scopes to the group', async () => {
  const ids = await mgr.getValidTabIds(mainTab);
  assert.ok(Array.isArray(ids) && ids.includes(mainTab), JSON.stringify(ids));
});

let failed = 0;
for (const [s, n, m] of results) { if (s === 'FAIL') failed++; console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${n}${m ? `\n        ${m}` : ''}`); }
console.log(`\n${results.length - failed}/${results.length} passed (real 1.0.90 code)`);
process.exit(failed ? 1 : 0);
