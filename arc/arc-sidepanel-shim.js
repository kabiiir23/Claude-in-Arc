/**
 * Arc SidePanel Shim
 * Polyfills chrome.sidePanel for Arc Browser where the API is unavailable.
 * Must be imported BEFORE the official service worker bundle so that all
 * references to chrome.sidePanel resolve to our polyfill.
 */

/** When true: write verbose diagnostics to chrome.storage.local (`claude_arc_debug_ring`). Ship with false. */
const ARC_SHIM_DEBUG = false;

// #region optional diagnostics (WebSocket / debugger / tabGroups)
const _SHIM_RING_KEY = 'claude_arc_debug_ring';
const _SHIM_RING_MAX = 200;
async function _shimRingAppend(payload) {
  if (!ARC_SHIM_DEBUG) return;
  try {
    const r = await chrome.storage.local.get(_SHIM_RING_KEY);
    const arr = Array.isArray(r[_SHIM_RING_KEY]) ? r[_SHIM_RING_KEY] : [];
    arr.push(payload);
    while (arr.length > _SHIM_RING_MAX) arr.shift();
    await chrome.storage.local.set({ [_SHIM_RING_KEY]: arr });
  } catch (e) {}
}
function _shimLog(hid, msg, data = {}) {
  if (!ARC_SHIM_DEBUG) return;
  const payload = {
    hypothesisId: hid,
    location: 'arc-sidepanel-shim.js',
    message: msg,
    data: { ...data, swTs: Date.now() },
    timestamp: Date.now(),
    runId: 'arc-shim-debug'
  };
  _shimRingAppend(payload).catch(() => {});
}

{
  const OrigWS = self.WebSocket;
  self.WebSocket = function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const isBridge = typeof url === 'string' &&
      (url.includes('bridge.claudeusercontent.com') || url.startsWith('ws://localhost:8765'));
    if (!isBridge) return ws;

    _shimLog('H3', 'bridge_ws_created', { url: url.replace(/\/[^/]{20,}$/, '/[TOKEN]') });

    const origSend = ws.send.bind(ws);
    self._arcBridgeWS = ws;
    self._arcBridgeSend = origSend;

    ws.send = function(data) {
      try {
        const parsed = JSON.parse(data);
        const sendLog = { type: parsed.type, client_type: parsed.client_type };
        if (parsed.type === 'connect' && parsed.device_id) {
          sendLog.local_device_id = parsed.device_id.slice(0, 12);
        }
        if (parsed.type === 'tool_result') {
          sendLog.tool_use_id = parsed.tool_use_id;
          sendLog.hasError = !!parsed.error;
          if (self._arcToolCallTracker) self._arcToolCallTracker.onToolResult();
        }
        _shimLog('H3', 'bridge_ws_send', sendLog);
      } catch (e) {
        _shimLog('H3', 'bridge_ws_send_raw', { len: data?.length });
      }
      return origSend(data);
    };

    ws.addEventListener('open', () => { _shimLog('H3', 'bridge_ws_open', {}); });
    ws.addEventListener('message', (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        const logData = { type: parsed.type };
        if (parsed.type === 'tool_call') {
          logData.tool = parsed.tool;
          logData.tool_use_id = parsed.tool_use_id;
          logData.target_device_id_prefix = parsed.target_device_id ? parsed.target_device_id.slice(0, 12) : '[none]';
          if (self._arcToolCallTracker) self._arcToolCallTracker.onToolCall(parsed.tool, parsed.tool_use_id);

          if (self._arcBridgeInterceptor?.canHandle(parsed.tool)) {
            logData.intercepted = true;
            _shimLog('INTERCEPT', 'dispatching_tool_call', {
              tool: parsed.tool, tool_use_id: parsed.tool_use_id
            });
            self._arcBridgeInterceptor.handleBridgeToolCall(parsed, origSend)
              .then(() => {
                _shimLog('INTERCEPT', 'tool_call_completed', {
                  tool: parsed.tool, tool_use_id: parsed.tool_use_id
                });
                if (self._arcToolCallTracker) self._arcToolCallTracker.onToolResult();
              })
              .catch(e => {
                _shimLog('INTERCEPT', 'tool_call_error', {
                  tool: parsed.tool, tool_use_id: parsed.tool_use_id, error: String(e)
                });
              });
          }
        }
        _shimLog('H3', 'bridge_ws_message', logData);
      } catch (e) {}
    });
    ws.addEventListener('close', (evt) => {
      _shimLog('H3', 'bridge_ws_close', { code: evt.code, reason: evt.reason, wasClean: evt.wasClean });
    });
    ws.addEventListener('error', () => { _shimLog('H3', 'bridge_ws_error', {}); });

    return ws;
  };
  self.WebSocket.prototype = OrigWS.prototype;
  self.WebSocket.CONNECTING = OrigWS.CONNECTING;
  self.WebSocket.OPEN = OrigWS.OPEN;
  self.WebSocket.CLOSING = OrigWS.CLOSING;
  self.WebSocket.CLOSED = OrigWS.CLOSED;
  _shimLog('H3', 'websocket_wrap_ok', {});
}

{
  const dbg = chrome.debugger;
  if (dbg) {
    const origAttach = dbg.attach.bind(dbg);
    const origDetach = dbg.detach.bind(dbg);
    const origSend = dbg.sendCommand.bind(dbg);

    dbg.attach = function(target, version, cb) {
      _shimLog('H4', 'debugger_attach_called', { target, version });
      if (cb) {
        return origAttach(target, version, (...args) => {
          const err = chrome.runtime.lastError?.message || null;
          _shimLog('H4', 'debugger_attach_cb', { target, error: err });
          cb(...args);
        });
      }
      const p = origAttach(target, version);
      if (p && typeof p.then === 'function') {
        return p.then(r => {
          _shimLog('H4', 'debugger_attach_ok', { target });
          return r;
        }).catch(e => {
          _shimLog('H4', 'debugger_attach_fail', { target, error: String(e) });
          throw e;
        });
      }
      return p;
    };

    dbg.detach = function(target, cb) {
      _shimLog('H4', 'debugger_detach_called', { target });
      if (cb) {
        return origDetach(target, (...args) => {
          _shimLog('H4', 'debugger_detach_cb', { target, error: chrome.runtime.lastError?.message || null });
          cb(...args);
        });
      }
      const p = origDetach(target);
      if (p && typeof p.then === 'function') {
        return p.then(r => { _shimLog('H4', 'debugger_detach_ok', { target }); return r; })
               .catch(e => { _shimLog('H4', 'debugger_detach_fail', { target, error: String(e) }); throw e; });
      }
      return p;
    };

    dbg.sendCommand = function(target, method, params, cb) {
      _shimLog('H4', 'debugger_sendCommand', { target, method });
      if (cb) {
        return origSend(target, method, params, (...args) => {
          _shimLog('H4', 'debugger_sendCommand_cb', { target, method, error: chrome.runtime.lastError?.message || null });
          cb(...args);
        });
      }
      const p = origSend(target, method, params);
      if (p && typeof p.then === 'function') {
        return p.then(r => { _shimLog('H4', 'debugger_cmd_ok', { target, method }); return r; })
               .catch(e => { _shimLog('H4', 'debugger_cmd_fail', { target, method, error: String(e) }); throw e; });
      }
      return p;
    };

    _shimLog('H4', 'debugger_wrap_ok', {});
  } else {
    _shimLog('H4', 'debugger_api_missing', {});
  }
}

{
  // Tab groups are handled by arc-tabgroups.js, which must be imported first.
  // 1.0.90 reads chrome.tabGroups.Color at module scope, so a stub here would
  // be both too late and too shallow.
  _shimLog('H5', 'tabgroups_delegated_to_shim', { present: !!chrome.tabGroups });
}

{
  chrome.storage.local.get('bridgeDeviceId').then(r => {
    _shimLog('H7', 'stored_bridgeDeviceId', {
      prefix: r.bridgeDeviceId ? r.bridgeDeviceId.slice(0, 12) : '[none]'
    });
  }).catch(() => {});
}

{
  const origQuery = chrome.tabs.query.bind(chrome.tabs);
  const origGet = chrome.tabs.get.bind(chrome.tabs);
  const origStorageGet = chrome.storage.local.get.bind(chrome.storage.local);
  let _toolCallPending = null;

  chrome.tabs.query = function(queryInfo) {
    if (_toolCallPending) {
      _shimLog('H8', 'tabs_query_during_tool', { queryInfo: JSON.stringify(queryInfo)?.slice(0, 100), tool: _toolCallPending });
    }
    return origQuery(queryInfo);
  };
  chrome.tabs.get = function(tabId) {
    if (_toolCallPending) {
      _shimLog('H8', 'tabs_get_during_tool', { tabId, tool: _toolCallPending });
    }
    return origGet(tabId);
  };

  chrome.storage.local.get = function(keys) {
    if (_toolCallPending) {
      const keyStr = typeof keys === 'string' ? keys : Array.isArray(keys) ? keys.join(',') : JSON.stringify(keys)?.slice(0, 80);
      if (!keyStr.includes('claude_arc_debug_ring')) {
        _shimLog('H9', 'storage_get_during_tool', { keys: keyStr, tool: _toolCallPending });
      }
    }
    return origStorageGet(keys);
  };

  self._arcToolCallTracker = {
    onToolCall(tool, toolUseId) {
      _toolCallPending = tool;
      setTimeout(() => {
        if (_toolCallPending === tool) {
          _shimLog('H7', 'tool_call_stalled_5s', { tool, toolUseId });
          // Force recovery
          _toolCallPending = null;
        }
      }, 5000);
    },
    onToolResult() { _toolCallPending = null; }
  };
  _shimLog('H7_H8', 'tabs_and_tracker_wrap_ok', {});
}
// #endregion

// #region agent log
_shimLog('H15', 'polyfill_decision', {
  nativeSidePanelExists: !!chrome.sidePanel,
  nativeOpenType: typeof chrome.sidePanel?.open
});
// #endregion
// Disable native openPanelOnActionClick so the browser doesn't swallow icon clicks
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// ─── Detached window mode ────────────────────────────────────────────────────
// The injected panel is an iframe inside the page, so any top-level navigation
// of its host tab destroys it — and the panel keeps no conversation state, so
// what comes back is a new session. A popup window is a top-level extension
// document: it survives navigation entirely, and gets first-party cookies
// without going through the auth proxy.
//
// Upstream already uses this shape for scheduled tasks and shortcuts:
// sidepanel.html?mode=window, opened with chrome.windows.create({type:'popup'}).
const VIEW_MODE_KEY = 'claude_arc_view_mode';       // 'injected' (default) | 'window'
const PANEL_WINDOW_KEY = 'claude_arc_panel_window';

async function _viewMode() {
  try {
    const r = await chrome.storage.local.get(VIEW_MODE_KEY);
    return r?.[VIEW_MODE_KEY] === 'window' ? 'window' : 'injected';
  } catch (e) { return 'injected'; }
}

async function _livePanelWindowId() {
  try {
    const r = await chrome.storage.session.get(PANEL_WINDOW_KEY);
    const id = r?.[PANEL_WINDOW_KEY];
    if (typeof id !== 'number') return null;
    await chrome.windows.get(id);   // throws once the user closes it
    return id;
  } catch (e) { return null; }
}

async function openPanelWindow() {
  const existing = await _livePanelWindowId();
  if (existing !== null) {
    await chrome.windows.update(existing, { focused: true }).catch(() => {});
    return existing;
  }
  // The panel resolves the tab it operates on as:
  //     tabId URL param  ->  else if mode=window: storage.session.targetTabId
  // Upstream's window mode is the task-runner surface, so it always sets
  // targetTabId before opening. Opening the window without either leaves the
  // panel with no target: no chat, nothing works. Set both.
  let targetTabId;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
    targetTabId = win?.tabs?.find(t => t.active)?.id;
    if (targetTabId === undefined) {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = t?.id;
    }
  } catch (e) {}
  if (targetTabId !== undefined) {
    await chrome.storage.session.set({ targetTabId }).catch(() => {});
  }

  // sessionId is upstream's prompt-delivery handshake token, not a resumable
  // conversation. One is generated per window purely to satisfy that contract.
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const url = chrome.runtime.getURL(
    `sidepanel.html?mode=window&sessionId=${sessionId}` +
    (targetTabId !== undefined ? `&tabId=${targetTabId}` : '')
  );
  const win = await chrome.windows.create({
    url, type: 'popup', width: 500, height: 768, left: 100, top: 100, focused: true
  });
  if (win?.id !== undefined) {
    await chrome.storage.session.set({ [PANEL_WINDOW_KEY]: win.id }).catch(() => {});
  }
  return win?.id;
}

async function closePanelWindow() {
  const id = await _livePanelWindowId();
  if (id === null) return;
  await chrome.windows.remove(id).catch(() => {});
  await chrome.storage.session.remove(PANEL_WINDOW_KEY).catch(() => {});
}

chrome.windows?.onRemoved.addListener(async (id) => {
  if (await _livePanelWindowId() === id) {
    await chrome.storage.session.remove(PANEL_WINDOW_KEY).catch(() => {});
  }
});

// Exposed so the options/console can flip modes without a rebuild.
// ponytail: no settings UI — adding one means editing Anthropic's bundle.
// `await __arcPanel.setViewMode('window')` is enough until it isn't.
// Announce the active mode at startup: it decides whether the panel can
// survive a navigation at all, and it is otherwise invisible.
_viewMode().then(m => console.log(
  `[Arc SidePanel Shim] view mode: ${m}` +
  (m === 'injected' ? '  (iframe in the page — dies on navigation; __arcPanel.setViewMode("window") to detach)' : '  (detached window)')
)).catch(() => {});

self.__arcPanel = {
  async setViewMode(mode) {
    if (mode !== 'window' && mode !== 'injected') throw new Error("mode must be 'window' or 'injected'");
    await chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
    if (mode === 'injected') await closePanelWindow();
    return mode;
  },
  getViewMode: _viewMode,
  openPanelWindow,
  closePanelWindow
};

const _needsPolyfill = true;

if (_needsPolyfill) {
  const _options = {};
  const _behavior = { openPanelOnActionClick: false };

  // Register action click unconditionally so the toolbar icon always works
  chrome.action?.onClicked.addListener(async (tab) => {
    _shimLog('H12', 'action_clicked', { tabId: tab?.id || null, url: tab?.url || '' });
    if (await _viewMode() === 'window') {
      const live = await _livePanelWindowId();
      if (live !== null) await closePanelWindow(); else await openPanelWindow();
      return;
    }
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_INJECTED_PANEL',
        tabId: tab.id
      });
      _shimLog('H12', 'action_toggle_sent', { tabId: tab.id });
    } catch (e) {
      _shimLog('H12', 'action_toggle_fail', { tabId: tab.id, error: String(e) });
    }
  });
  _shimLog('H12', 'action_listener_registered_unconditional', {});

  chrome.sidePanel = {
    async open(opts) {
      const tabId = opts?.tabId;
      _shimLog('H12', 'sidePanel_open_called', { tabId: tabId || null });
      if (await _viewMode() === 'window') return void await openPanelWindow();
      if (!tabId) {
        // No tab to dock into at all — a window is the only surface left.
        return void await openPanelWindow();
      }
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SHOW_INJECTED_PANEL',
          tabId
        });
        _shimLog('H12', 'sidePanel_open_dispatched', { tabId });
      } catch (e) {
        // No content script in that tab. Usually a restricted URL, and that is
        // the *normal* case here rather than an edge one: Claude's own session
        // tabs are chrome://newtab, and the tab-group interstitial's "Open
        // chat" button targets exactly that tab. Docking is impossible there,
        // so fall back to the detached window instead of failing silently.
        _shimLog('H12', 'sidePanel_open_send_fail', { tabId, error: String(e) });
        await openPanelWindow();
      }
    },

    async close(opts) {
      const tabId = opts?.tabId;
      if (await _viewMode() === 'window') return void await closePanelWindow();
      if (!tabId) return;
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'HIDE_INJECTED_PANEL',
          tabId
        });
      } catch (e) {}
    },

    async setOptions(opts) {
      Object.assign(_options, opts);
    },

    async getOptions(_query) {
      return { ..._options };
    },

    async setPanelBehavior(behavior) {
      Object.assign(_behavior, behavior);
      _shimLog('H12', 'setPanelBehavior_called', { behavior });
    },

    async getPanelBehavior() {
      return { ..._behavior };
    },

    onStateChanged: {
      addListener() {},
      removeListener() {},
      hasListener() { return false; }
    }
  };

  console.log('[Arc SidePanel Shim] Polyfill installed');
}
