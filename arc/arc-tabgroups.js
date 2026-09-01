/**
 * Arc Tab Groups Shim
 * Emulates chrome.tabGroups + chrome.tabs.group/ungroup for Arc, which ships
 * neither. Claude 1.0.90 uses tab groups as its tool-session scoping primitive,
 * so a no-op stub makes every bridge tool fail with "no tab group exists for
 * this session". This keeps a real registry instead.
 *
 * Must be imported BEFORE the official service worker bundle: that bundle reads
 * chrome.tabGroups.Color and TAB_GROUP_ID_NONE at module evaluation time
 * (e.g. `static SESSION_GROUP_COLORS = [chrome.tabGroups.Color.BLUE, ...]`),
 * so the object has to exist synchronously.
 *
 * Groups are metadata-only — Arc renders no group UI. Membership, lifetime and
 * lookup semantics match Chrome, which is all the extension actually reads.
 */

const NONE = -1;
const STORAGE_KEY = 'claude_arc_tabgroups';
const FIRST_GROUP_ID = 1000; // ponytail: arbitrary base, just avoids colliding with real tab ids in logs

const COLORS = {
  GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green',
  PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange'
};
const COLOR_LIST = Object.values(COLORS);

// ─── State ───────────────────────────────────────────────────────────────────
let _nextId = FIRST_GROUP_ID;
let _groups = new Map();   // groupId -> { id, title, color, collapsed, windowId }
let _members = new Map();  // tabId   -> groupId
let _ready = null;

function _serialize() {
  return {
    nextId: _nextId,
    groups: [..._groups.values()],
    members: [..._members.entries()]
  };
}

async function _persist() {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: _serialize() });
  } catch (e) {}
}

async function _load() {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEY);
    const s = r?.[STORAGE_KEY];
    if (!s) return;
    _nextId = s.nextId ?? FIRST_GROUP_ID;
    _groups = new Map((s.groups || []).map(g => [g.id, g]));
    _members = new Map(s.members || []);
  } catch (e) {}
}

function ready() {
  if (!_ready) _ready = _load();
  return _ready;
}

// The sidepanel and options pages call chrome.tabGroups directly too, so the
// registry has to be shared across extension contexts. storage.session is the
// single source of truth; a write in any context invalidates every cache.
// ponytail: last-write-wins on a concurrent read-modify-write. These calls are
// user-paced and rare — add a worker-owned lock only if that ever bites.
try {
  chrome.storage.session.onChanged?.addListener(changes => {
    if (STORAGE_KEY in changes) _ready = _load();
  });
} catch (e) {}

// ─── Synthetic tabs.onUpdated ────────────────────────────────────────────────
// The extension detects group changes by subscribing to chrome.tabs.onUpdated
// and looking for `groupId` in changeInfo. Arc will never emit that, so we do.
const _updateListeners = new Set();

function _wrapOnUpdated() {
  const real = chrome.tabs.onUpdated;
  const origAdd = real.addListener.bind(real);
  const origRemove = real.removeListener.bind(real);
  real.addListener = fn => { _updateListeners.add(fn); origAdd(fn); };
  real.removeListener = fn => { _updateListeners.delete(fn); origRemove(fn); };
}

async function _emitGroupChange(tabId, groupId) {
  if (_updateListeners.size === 0) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  for (const fn of _updateListeners) {
    try { fn(tabId, { groupId }, tab); } catch (e) {}
  }
}

// ─── tabs.get / tabs.query stamping ──────────────────────────────────────────
function _stamp(tab) {
  if (tab && typeof tab.id === 'number') tab.groupId = _members.get(tab.id) ?? NONE;
  return tab;
}

function _wrapTabs() {
  const origGet = chrome.tabs.get.bind(chrome.tabs);
  const origQuery = chrome.tabs.query.bind(chrome.tabs);
  const origCreate = chrome.tabs.create.bind(chrome.tabs);

  chrome.tabs.get = async function (tabId) {
    await ready();
    return _stamp(await origGet(tabId));
  };

  chrome.tabs.query = async function (queryInfo) {
    await ready();
    // groupId is not a key Arc understands — filter on it ourselves.
    const { groupId, ...rest } = queryInfo || {};
    const tabs = (await origQuery(rest)).map(_stamp);
    if (groupId === undefined) return tabs;
    return tabs.filter(t => t.groupId === groupId);
  };

  chrome.tabs.create = async function (props) {
    await ready();
    return _stamp(await origCreate(props));
  };

  // A closed tab leaves its group; a group with no tabs stops existing, which is
  // exactly the condition the extension probes for with `await tabGroups.get()`.
  chrome.tabs.onRemoved.addListener(async tabId => {
    await ready();
    const gid = _members.get(tabId);
    if (gid === undefined) return;
    _members.delete(tabId);
    if (![..._members.values()].includes(gid)) {
      _groups.delete(gid);
      _dispatch(chrome.tabGroups.onRemoved, { id: gid });
    }
    await _persist();
  });
}

// ─── Event plumbing for chrome.tabGroups.on* ─────────────────────────────────
function _event() {
  const set = new Set();
  return {
    addListener: fn => set.add(fn),
    removeListener: fn => set.delete(fn),
    hasListener: fn => set.has(fn),
    _fire: arg => { for (const fn of set) { try { fn(arg); } catch (e) {} } }
  };
}

function _dispatch(ev, arg) { ev?._fire?.(arg); }

// ─── chrome.tabs.group / ungroup ─────────────────────────────────────────────
async function group(options) {
  await ready();
  const { tabIds, groupId, createProperties } = options || {};
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (ids.some(id => typeof id !== 'number')) throw new Error('tabIds must be tab id numbers');

  let gid = groupId;
  if (gid === undefined) {
    let windowId = createProperties?.windowId;
    if (windowId === undefined) {
      try { windowId = (await chrome.tabs.get(ids[0])).windowId; } catch {}
    }
    gid = _nextId++;
    _groups.set(gid, { id: gid, title: '', color: COLORS.GREY, collapsed: false, windowId });
    _dispatch(chrome.tabGroups.onCreated, _groups.get(gid));
  } else if (!_groups.has(gid)) {
    throw new Error(`No group with id: ${gid}.`);
  }

  for (const id of ids) {
    if (_members.get(id) === gid) continue;
    _members.set(id, gid);
    await _emitGroupChange(id, gid);
  }
  await _persist();
  return gid;
}

async function ungroup(tabIds) {
  await ready();
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const touched = new Set();
  for (const id of ids) {
    const gid = _members.get(id);
    if (gid === undefined) continue;
    _members.delete(id);
    touched.add(gid);
    await _emitGroupChange(id, NONE);
  }
  const live = new Set(_members.values());
  for (const gid of touched) {
    if (!live.has(gid)) {
      _groups.delete(gid);
      _dispatch(chrome.tabGroups.onRemoved, { id: gid });
    }
  }
  await _persist();
}

// ─── chrome.tabGroups ────────────────────────────────────────────────────────
// Defined synchronously: the official bundle reads Color/TAB_GROUP_ID_NONE at
// module scope, before any await can resolve.
const tabGroups = {
  TAB_GROUP_ID_NONE: NONE,
  Color: COLORS,
  __arcEmulated: true,   // lets the self-test say which implementation is live

  async get(groupId) {
    await ready();
    const g = _groups.get(groupId);
    // Rejecting is load-bearing: several call sites use this to detect that a
    // session's group died so they can re-establish it.
    if (!g) throw new Error(`No group with id: ${groupId}.`);
    return { ...g };
  },

  async query(queryInfo) {
    await ready();
    let out = [..._groups.values()];
    const q = queryInfo || {};
    if (q.collapsed !== undefined) out = out.filter(g => g.collapsed === q.collapsed);
    if (q.color !== undefined) out = out.filter(g => g.color === q.color);
    if (q.title !== undefined) out = out.filter(g => g.title === q.title);
    if (q.windowId !== undefined && q.windowId !== -2) out = out.filter(g => g.windowId === q.windowId);
    return out.map(g => ({ ...g }));
  },

  async update(groupId, props) {
    await ready();
    const g = _groups.get(groupId);
    if (!g) throw new Error(`No group with id: ${groupId}.`);
    if (props?.title !== undefined) g.title = props.title;
    if (props?.color !== undefined) {
      if (!COLOR_LIST.includes(props.color)) throw new Error(`Invalid color: ${props.color}`);
      g.color = props.color;
    }
    if (props?.collapsed !== undefined) g.collapsed = props.collapsed;
    await _persist();
    _dispatch(tabGroups.onUpdated, { ...g });
    return { ...g };
  },

  async move(groupId, moveProperties) {
    await ready();
    const g = _groups.get(groupId);
    if (!g) throw new Error(`No group with id: ${groupId}.`);
    // ponytail: Arc has no group strip to reorder; accept and report the group
    // unchanged. Revisit only if a caller starts reading the new index.
    if (moveProperties?.windowId !== undefined) g.windowId = moveProperties.windowId;
    await _persist();
    return { ...g };
  },

  onCreated: _event(),
  onUpdated: _event(),
  onRemoved: _event(),
  onMoved: _event()
};

// ─── Install ─────────────────────────────────────────────────────────────────
const NATIVE_OK_KEY = 'claude_arc_native_tabgroups_ok';

function installEmulation() {
  if (chrome.tabGroups === tabGroups) return;
  chrome.tabGroups = tabGroups;
  chrome.tabs.group = group;
  chrome.tabs.ungroup = ungroup;
  _wrapOnUpdated();
  _wrapTabs();
  ready();
}

/**
 * Does the live implementation actually group tabs? Presence of the API proves
 * nothing: a Chromium fork can expose chrome.tabGroups and still refuse to
 * group. Claude uses tab groups to give itself a working tab, so a broken
 * native API means every tool lands on the user's active tab instead — which
 * in Arc is the tab hosting the injected panel.
 * Runs on a throwaway background tab.
 */
async function probeNative() {
  let tabId;
  try {
    const t = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = t.id;
    const gid = await chrome.tabs.group({ tabIds: [tabId] });
    if (typeof gid !== 'number' || gid === NONE) return false;
    if (!(await chrome.tabGroups.get(gid))) return false;
    if ((await chrome.tabs.get(tabId)).groupId !== gid) return false;
    return (await chrome.tabs.query({ groupId: gid })).length === 1;
  } catch (e) {
    return false;
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function install() {
  if (!chrome.tabGroups || typeof chrome.tabs.group !== 'function') {
    installEmulation();
    return 'emulation installed (no native API)';
  }

  // Native API is present. Trust it only once it has demonstrably worked. The
  // verdict is cached, so the probe costs one background tab per install
  // rather than one per service-worker wake-up.
  (async () => {
    let ok;
    try {
      const c = await chrome.storage.local.get(NATIVE_OK_KEY);
      ok = c?.[NATIVE_OK_KEY];
    } catch (e) {}

    if (typeof ok !== 'boolean') {
      if (typeof window !== 'undefined') return;  // only the worker may spawn a probe tab
      ok = await probeNative();
      try { await chrome.storage.local.set({ [NATIVE_OK_KEY]: ok }); } catch (e) {}
    }

    if (!ok) {
      installEmulation();
      console.log('[Arc Tab Groups] native API present but non-functional - emulation installed');
    }
  })();

  return 'native API present, probing';
}

console.log(`[Arc Tab Groups] ${install()}`);

// No import/export statements: this file is valid both as an ES module (the
// service worker imports it) and as a classic <script src> (the sidepanel and
// options pages load it), so one file covers every context.
// Test seam — ignored by the extension, used by the harnesses.
globalThis.__arcTabGroups = {
  /**
   * Functionally probe whatever chrome.tabGroups is currently live, on a
   * throwaway tab. Presence of the API is not proof it works: a Chromium fork
   * can expose tabGroups and still refuse to group anything.
   */
  async selfTest({ recheck = false } = {}) {
    if (recheck) { try { await chrome.storage.local.remove(NATIVE_OK_KEY); } catch (e) {} }
    const out = {
      impl: chrome.tabGroups?.__arcEmulated ? 'emulated' : 'native',
      cachedNativeVerdict: (await chrome.storage.local.get(NATIVE_OK_KEY).catch(() => ({})))?.[NATIVE_OK_KEY] ?? '(unprobed)'
    };
    let tabId;
    try {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false });
      tabId = t.id;
      const gid = await chrome.tabs.group({ tabIds: [tabId] });
      out.groupId = gid;
      out.groupIdUsable = typeof gid === 'number' && gid !== NONE;
      out.get = await chrome.tabGroups.get(gid).then(g => ({ ok: true, color: g.color }),
                                                     e => ({ ok: false, error: String(e.message || e) }));
      out.stampedOnTab = (await chrome.tabs.get(tabId)).groupId;
      out.queryMembers = (await chrome.tabs.query({ groupId: gid })).length;
      out.verdict = out.groupIdUsable && out.get.ok &&
                    out.stampedOnTab === gid && out.queryMembers === 1 ? 'WORKS' : 'BROKEN';
    } catch (e) {
      out.error = String(e.message || e);
      out.verdict = 'BROKEN';
    } finally {
      if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
    }
    return out;
  },

  reset() {
    _nextId = FIRST_GROUP_ID;
    _groups = new Map();
    _members = new Map();
    _ready = Promise.resolve();
  },
  state: () => _serialize()
};
