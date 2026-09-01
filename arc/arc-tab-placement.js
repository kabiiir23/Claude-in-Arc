/**
 * Arc Tab Placement
 *
 * When Claude needs a tab of its own it calls chrome.windows.create with
 * type:'normal' (getOrCreateMcpTabContext, getOrCreateSessionTabContext, and
 * the scheduled-task runner). In Chrome that lands beside your tabs in the same
 * window, visually distinguished by the tab group's colour and title.
 *
 * Arc has no tab groups and no group UI, and its Spaces are invisible to the
 * extension API — every Space reports the same windowId — so that same call
 * produces a whole separate Arc window instead. This redirects it into the
 * current window, so Claude's tabs appear in whatever Space you are working in.
 *
 * Isolation is unaffected: which tabs belong to Claude is tracked by the
 * emulated tab group, not by which window they live in, and tools stay scoped
 * to that group. What changes is only where the tabs appear.
 *
 * Worker-only. No import/export, so it loads as an ES module import.
 */

const PLACEMENT_KEY = 'claude_arc_tab_placement';   // 'current' (default) | 'new-window'

if (typeof window === 'undefined' && chrome.windows?.create) {
  const origCreate = chrome.windows.create.bind(chrome.windows);
  const EXT_PREFIX = chrome.runtime.getURL('');

  async function placement() {
    try {
      const r = await chrome.storage.local.get(PLACEMENT_KEY);
      return r?.[PLACEMENT_KEY] === 'new-window' ? 'new-window' : 'current';
    } catch (e) { return 'current'; }
  }

  const urls = opts => (Array.isArray(opts?.url) ? opts.url : opts?.url ? [opts.url] : []);

  chrome.windows.create = async function (opts = {}) {
    // Popups are panels — ours and upstream's task panel. They must stay windows.
    if (opts.type && opts.type !== 'normal') return origCreate(opts);

    // One upstream call omits `type` (so it defaults to normal) but opens
    // sidepanel.html. Anything on the extension origin is a panel, not work.
    if (urls(opts).some(u => typeof u === 'string' && u.startsWith(EXT_PREFIX))) {
      return origCreate(opts);
    }

    if (await placement() !== 'current') return origCreate(opts);

    let target;
    try {
      target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    } catch (e) { /* fall through */ }
    if (!target || target.id === undefined) return origCreate(opts);

    const wanted = urls(opts);
    const active = opts.focused !== false;
    const tabs = [];
    try {
      for (const [i, url] of (wanted.length ? wanted : [undefined]).entries()) {
        tabs.push(await chrome.tabs.create({
          windowId: target.id, url, active: active && i === 0
        }));
      }
    } catch (e) {
      return origCreate(opts);   // e.g. the window vanished mid-flight
    }

    // Shape the callers rely on: `(await create(...))?.tabs?.[0]?.id`.
    return { id: target.id, focused: active, type: 'normal', tabs };
  };

  self.__arcTabPlacement = {
    async set(mode) {
      if (mode !== 'current' && mode !== 'new-window') {
        throw new Error("mode must be 'current' or 'new-window'");
      }
      await chrome.storage.local.set({ [PLACEMENT_KEY]: mode });
      return mode;
    },
    get: placement
  };

  console.log('[Arc Tab Placement] work tabs open in the current window');
}
