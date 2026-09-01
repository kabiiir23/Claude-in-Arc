/**
 * Spike harness: fake Arc's chrome API (no tabGroups, no tabs.group), install
 * the shim, then replay the exact sequences Claude 1.0.90 performs — transcribed
 * from the built extension's own bundles.
 *
 * Run: node test-arc-tabgroups.mjs
 */
import assert from 'node:assert/strict';
import { shimPath, tabGroupBundle } from './_bundles.mjs';
import { copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Fake Arc chrome ─────────────────────────────────────────────────────────
function makeEvent() {
  const set = new Set();
  return {
    addListener: fn => set.add(fn),
    removeListener: fn => set.delete(fn),
    hasListener: fn => set.has(fn),
    _fire: (...a) => { for (const fn of [...set]) fn(...a); }
  };
}

let nextTabId = 1;
const tabs = new Map();
const store = {};

function makeChrome() {
  return {
    runtime: { id: 'spike', lastError: null },
    tabs: {
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return { ...t };
      },
      async query(q = {}) {
        // Arc knows nothing about groupId; if the shim leaked it through, that's a bug.
        assert.equal('groupId' in q, false, 'groupId must not reach the real tabs.query');
        let out = [...tabs.values()];
        if (q.windowId !== undefined) out = out.filter(t => t.windowId === q.windowId);
        if (q.active !== undefined) out = out.filter(t => t.active === q.active);
        if (q.currentWindow !== undefined) out = out.filter(t => t.windowId === 1);
        return out.map(t => ({ ...t }));
      },
      async create(props = {}) {
        const t = {
          id: nextTabId++, windowId: props.windowId ?? 1,
          url: props.url ?? 'about:blank', title: 'New Tab',
          active: props.active !== false, index: tabs.size
        };
        tabs.set(t.id, t);
        return { ...t };
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          tabs.delete(id);
          chromeObj.tabs.onRemoved._fire(id, { windowId: 1, isWindowClosing: false });
        }
      },
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onActivated: makeEvent()
    },
    windows: {
      async get(id) { return { id, state: 'normal' }; },
      async getLastFocused() { return { id: 1, state: 'normal' }; },
      async create() { return { id: 2, tabs: [await chromeObj.tabs.create({ windowId: 2 })] }; },
      async update(id, p) { return { id, ...p }; }
    },
    storage: {
      session: {
        async get(k) { return k in store ? { [k]: store[k] } : {}; },
        async set(o) { Object.assign(store, o); },
        async remove(k) { delete store[k]; }
      }
    }
  };
}

let chromeObj = makeChrome();
globalThis.chrome = chromeObj;

await import(shimPath());
const { __arcTabGroups } = globalThis;

const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;
const MCP_TITLE = 'Claude'; // stands in for the bundle's `ws` constant

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, (e.stack||e.message).split('\n').slice(0,4).join(' | ')]); }
}

function freshTab(windowId = 1) {
  const t = { id: nextTabId++, windowId, url: 'https://example.com', title: 'Example', active: true, index: tabs.size };
  tabs.set(t.id, t);
  return t.id;
}

// ─── Transcribed from the 1.0.90 bundle ──────────────────────────────────────

// groupTabInOwnWindow(e)
async function groupTabInOwnWindow(e) {
  const { windowId: t } = await chrome.tabs.get(e);
  return chrome.tabs.group({ tabIds: [e], createProperties: { windowId: t } });
}

// createGroup(e) — retry loop, ungroup-if-foreign, then title/color/collapse
async function createGroup(e, knownMainTabs = new Set()) {
  const r = await chrome.tabs.get(e);
  if (r.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !knownMainTabs.has(r.groupId)) {
    await chrome.tabs.ungroup([e]);
  }
  let n, a = 3;
  for (; a > 0;) {
    try { n = await groupTabInOwnWindow(e); break; }
    catch (c) { if (--a === 0) throw c; }
  }
  if (!n) throw new Error('Failed to create Chrome tab group');
  await chrome.tabGroups.update(n, { title: MCP_TITLE, color: chrome.tabGroups.Color.ORANGE, collapsed: false });
  return { chromeGroupId: n, mainTabId: e };
}

// getOrCreateMcpTabContext({createIfEmpty}) — the tabs_context_mcp path
async function getOrCreateMcpTabContext(mcpTabGroupId, { createIfEmpty = false } = {}) {
  if (mcpTabGroupId !== null) {
    try {
      await chrome.tabGroups.get(mcpTabGroupId);
      const t = await chrome.tabGroups.get(mcpTabGroupId);
      if (t.title !== MCP_TITLE || t.color !== chrome.tabGroups.Color.YELLOW) {
        await chrome.tabGroups.update(mcpTabGroupId, { title: MCP_TITLE, color: chrome.tabGroups.Color.YELLOW });
      }
      const e = (await chrome.tabs.query({ groupId: mcpTabGroupId }))
        .filter(x => x.id !== undefined)
        .map(x => ({ id: x.id, title: x.title, url: x.url }));
      if (e.length > 0) return { currentTabId: e[0].id, availableTabs: e, tabCount: e.length, tabGroupId: mcpTabGroupId };
    } catch {}
  }
  if (!createIfEmpty) return undefined;
  const w = await chrome.windows.create({ url: 'chrome://newtab', focused: true, type: 'normal' });
  const e = w?.tabs?.[0]?.id;
  if (!e) throw new Error('Failed to create window with new tab');
  const t = await createGroup(e);
  await chrome.tabGroups.update(t.chromeGroupId, { title: MCP_TITLE, color: chrome.tabGroups.Color.YELLOW });
  return { currentTabId: e, availableTabs: [{ id: e, title: 'New Tab', url: 'chrome://newtab' }], tabCount: 1, tabGroupId: t.chromeGroupId };
}

// tabs_create_mcp — the "group no longer exists" gate
async function tabsCreateMcp(sessionScope) {
  let r, e;
  if (!sessionScope?.tabGroupId) {
    return { error: 'No tab group exists for this session yet.', errorCode: 'tab_create_no_group' };
  }
  try {
    ({ windowId: r } = await chrome.tabGroups.get(sessionScope.tabGroupId));
    e = sessionScope.tabGroupId;
  } catch {
    return {
      error: "This session's tab group no longer exists (tabs were closed).",
      errorCode: 'tab_create_group_gone'
    };
  }
  const n = await chrome.tabs.create({ windowId: r, url: 'chrome://newtab', active: false });
  if (!n.id) throw new Error('Failed to create tab - no tab ID returned');
  await chrome.tabs.group({ tabIds: n.id, groupId: e });
  const o = (await chrome.tabs.query({ groupId: e })).filter(x => x.id !== undefined)
    .map(x => ({ id: x.id, title: x.title || '', url: x.url || '' }));
  return { output: `Created new tab. Tab ID: ${n.id}`, availableTabs: o };
}

// isTabInSameGroup(e,t)
async function isTabInSameGroup(e, t) {
  try {
    const [r, n] = await Promise.all([chrome.tabs.get(e), chrome.tabs.get(t)]);
    return r.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? e === t : r.groupId === n.groupId;
  } catch { return false; }
}

// updateGroupTitle — least-used-color selection over tabGroups.query({})
async function updateGroupTitle(chromeGroupId, title) {
  if ((await chrome.tabGroups.get(chromeGroupId)).title !== MCP_TITLE) return;
  const used = (await chrome.tabGroups.query({})).filter(g => g.id !== chromeGroupId).map(g => g.color);
  const all = Object.values(chrome.tabGroups.Color);
  const free = all.filter(c => !used.includes(c));
  const color = free.length > 0 ? free[0] : chrome.tabGroups.Color.ORANGE;
  await chrome.tabGroups.update(chromeGroupId, { title: title.trim(), color });
}

// ─── Checks ──────────────────────────────────────────────────────────────────

await check('module scope: Color + TAB_GROUP_ID_NONE readable synchronously', () => {
  // The bundle does `static SESSION_GROUP_COLORS=[chrome.tabGroups.Color.BLUE, ...]`
  // at class-definition time. If these were behind an await, the bundle would
  // throw on import.
  assert.equal(NONE, -1);
  assert.equal(chrome.tabGroups.Color.BLUE, 'blue');
  assert.equal(Object.values(chrome.tabGroups.Color).length, 9);
});

await check('createGroup: allocates a group, tab reports its groupId', async () => {
  const tab = freshTab();
  const g = await createGroup(tab);
  assert.ok(g.chromeGroupId >= 1000);
  assert.equal((await chrome.tabs.get(tab)).groupId, g.chromeGroupId);
  const meta = await chrome.tabGroups.get(g.chromeGroupId);
  assert.equal(meta.title, MCP_TITLE);
  assert.equal(meta.color, 'orange');
  assert.equal(meta.collapsed, false);
  assert.equal(meta.windowId, 1);
});

await check('createGroup twice: distinct ids (group rotation)', async () => {
  const a = await createGroup(freshTab());
  const b = await createGroup(freshTab());
  assert.notEqual(a.chromeGroupId, b.chromeGroupId);
});

await check('ungrouped tab reports TAB_GROUP_ID_NONE', async () => {
  assert.equal((await chrome.tabs.get(freshTab())).groupId, NONE);
});

await check('tabs.query({groupId}) returns only members', async () => {
  const main = freshTab();
  const g = (await createGroup(main)).chromeGroupId;
  const extra = freshTab();
  await chrome.tabs.group({ tabIds: [extra], groupId: g });
  freshTab(); // outsider
  const members = await chrome.tabs.query({ groupId: g });
  assert.deepEqual(members.map(t => t.id).sort((x, y) => x - y), [main, extra].sort((x, y) => x - y));
});

await check('tabs.query({groupId: NONE}) finds orphans (findOrphanedTabs)', async () => {
  const orphan = freshTab();
  const orphans = await chrome.tabs.query({ groupId: NONE });
  assert.ok(orphans.some(t => t.id === orphan));
  assert.ok(orphans.every(t => t.groupId === NONE));
});

await check('tabs.group into a nonexistent group rejects', async () => {
  await assert.rejects(() => chrome.tabs.group({ tabIds: [freshTab()], groupId: 999999 }));
});

await check('tabGroups.get on unknown id rejects (drives "group gone" recovery)', async () => {
  await assert.rejects(() => chrome.tabGroups.get(424242));
});

await check('group dies when its last tab closes', async () => {
  const main = freshTab();
  const g = (await createGroup(main)).chromeGroupId;
  await chrome.tabGroups.get(g); // alive
  await chrome.tabs.remove(main);
  await new Promise(r => setImmediate(r)); // onRemoved handler is async
  await assert.rejects(() => chrome.tabGroups.get(g), /No group with id/);
});

await check('group survives while any member remains', async () => {
  const a = freshTab(), b = freshTab();
  const g = (await createGroup(a)).chromeGroupId;
  await chrome.tabs.group({ tabIds: [b], groupId: g });
  await chrome.tabs.remove(a);
  await new Promise(r => setImmediate(r));
  assert.equal((await chrome.tabGroups.get(g)).id, g);
  assert.equal((await chrome.tabs.query({ groupId: g })).length, 1);
});

await check('ungroup removes membership and reaps the empty group', async () => {
  const t = freshTab();
  const g = (await createGroup(t)).chromeGroupId;
  await chrome.tabs.ungroup([t]);
  assert.equal((await chrome.tabs.get(t)).groupId, NONE);
  await assert.rejects(() => chrome.tabGroups.get(g));
});

await check('tabs.onUpdated fires with groupId in changeInfo', async () => {
  const seen = [];
  const listener = (tabId, changeInfo) => { if ('groupId' in changeInfo) seen.push([tabId, changeInfo.groupId]); };
  chrome.tabs.onUpdated.addListener(listener);
  const t = freshTab();
  const g = (await createGroup(t)).chromeGroupId;
  await chrome.tabs.ungroup([t]);
  chrome.tabs.onUpdated.removeListener(listener);
  assert.deepEqual(seen, [[t, g], [t, NONE]]);
});

await check('isTabInSameGroup matches bundle semantics', async () => {
  const a = freshTab(), b = freshTab(), lone = freshTab();
  const g = (await createGroup(a)).chromeGroupId;
  await chrome.tabs.group({ tabIds: [b], groupId: g });
  assert.equal(await isTabInSameGroup(a, b), true);
  assert.equal(await isTabInSameGroup(a, lone), false);
  assert.equal(await isTabInSameGroup(lone, lone), true, 'ungrouped tab is in its own group only');
  assert.equal(await isTabInSameGroup(lone, a), false);
});

await check('tabs_context_mcp: createIfEmpty establishes a session group', async () => {
  const ctx = await getOrCreateMcpTabContext(null, { createIfEmpty: true });
  assert.ok(ctx.tabGroupId);
  assert.equal(ctx.tabCount, 1);
  const meta = await chrome.tabGroups.get(ctx.tabGroupId);
  assert.equal(meta.color, 'yellow');
});

await check('tabs_context_mcp: reuses an existing group', async () => {
  const first = await getOrCreateMcpTabContext(null, { createIfEmpty: true });
  const again = await getOrCreateMcpTabContext(first.tabGroupId, { createIfEmpty: false });
  assert.equal(again.tabGroupId, first.tabGroupId);
  assert.equal(again.currentTabId, first.currentTabId);
});

await check('tabs_context_mcp: no group + no createIfEmpty returns undefined', async () => {
  assert.equal(await getOrCreateMcpTabContext(null, { createIfEmpty: false }), undefined);
});

await check('tabs_create_mcp: adds a tab to the session group', async () => {
  const ctx = await getOrCreateMcpTabContext(null, { createIfEmpty: true });
  const r = await tabsCreateMcp({ tabGroupId: ctx.tabGroupId });
  assert.ok(r.output?.startsWith('Created new tab'), JSON.stringify(r));
  assert.equal(r.availableTabs.length, 2);
});

await check('tabs_create_mcp: reports group_gone after the group dies', async () => {
  const ctx = await getOrCreateMcpTabContext(null, { createIfEmpty: true });
  await chrome.tabs.remove(ctx.currentTabId);
  await new Promise(r => setImmediate(r));
  const r = await tabsCreateMcp({ tabGroupId: ctx.tabGroupId });
  assert.equal(r.errorCode, 'tab_create_group_gone');
});

await check('updateGroupTitle: picks an unused color, sets title', async () => {
  const g = (await createGroup(freshTab())).chromeGroupId;
  await updateGroupTitle(g, '  Research  ');
  const meta = await chrome.tabGroups.get(g);
  assert.equal(meta.title, 'Research');
  assert.ok(Object.values(chrome.tabGroups.Color).includes(meta.color));
});

await check('tabGroups.query({}) lists live groups only', async () => {
  __arcTabGroups.reset();
  const a = (await createGroup(freshTab())).chromeGroupId;
  const b = (await createGroup(freshTab())).chromeGroupId;
  let all = await chrome.tabGroups.query({});
  assert.deepEqual(all.map(g => g.id).sort(), [a, b].sort());
  await chrome.tabs.ungroup((await chrome.tabs.query({ groupId: a })).map(t => t.id));
  all = await chrome.tabGroups.query({});
  assert.deepEqual(all.map(g => g.id), [b]);
});

await check('reconcileWithChrome: tabs.query({}) groupIds match tabs.get()', async () => {
  __arcTabGroups.reset();
  const t = freshTab();
  const g = (await createGroup(t)).chromeGroupId;
  const all = await chrome.tabs.query({});
  const live = new Set(all.filter(x => x.groupId !== NONE).map(x => x.groupId));
  assert.ok(live.has(g));
  assert.equal((await chrome.tabs.get(t)).groupId, g);
});

await check('state survives a service-worker restart (storage.session)', async () => {
  const t = freshTab();
  const g = (await createGroup(t)).chromeGroupId;

  // Simulate SW teardown + fresh import: same storage, new module state.
  const saved = JSON.parse(JSON.stringify(store));
  chromeObj = makeChrome();
  globalThis.chrome = chromeObj;
  Object.assign(store, saved);
  // The shim deliberately has no import/export (so it loads as both an ES module
  // and a classic script), which makes Node treat it as CJS and cache it by path.
  // Copy it to force a genuinely fresh instance, the way a worker restart would.
  const tmp = join(dirname(fileURLToPath(import.meta.url)), `.restart-${Date.now()}.mjs`);
  copyFileSync(shimPath(), tmp);
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }

  const meta = await chrome.tabGroups.get(g);
  assert.equal(meta.id, g);
  assert.equal((await chrome.tabs.get(t)).groupId, g, 'membership restored');
  const members = await chrome.tabs.query({ groupId: g });
  assert.deepEqual(members.map(x => x.id), [t]);
});

// ─── Report ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const [status, name, msg] of results) {
  if (status === 'FAIL') failed++;
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        ${msg}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
