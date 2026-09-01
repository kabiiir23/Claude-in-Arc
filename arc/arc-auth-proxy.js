/**
 * Arc Auth Proxy
 *
 * The panel runs as an iframe inside an arbitrary page, so a credentialed
 * fetch to claude.ai computes its site-for-cookies from the *top-level* page,
 * not from the extension. claude.ai's session cookies (sessionKey,
 * sessionKeyV3, lastActiveOrg) are all SameSite=Lax, so they are never sent
 * from that context and `/api/bootstrap` comes back with `account: null` —
 * the panel concludes you are signed out no matter how signed in you are.
 * No cookie setting fixes this; SameSite=Lax is not a third-party-cookie
 * policy.
 *
 * The service worker has no frame tree, so the same request there is
 * first-party and the cookies attach. This file routes the handful of
 * credentialed claude.ai requests through it.
 *
 * Scope is deliberately narrow: only requests to claude.ai that ask for
 * credentials. In 1.0.90 that is `/api/bootstrap` (login detection) plus two
 * analytics batches. Everything substantive uses a Bearer token against
 * api.anthropic.com and is left completely alone, so streaming is untouched.
 *
 * Loaded in both contexts, like arc-tabgroups.js: no import/export, so it
 * works as a worker ES module and as a classic <script src> in the panel.
 */

const MSG = 'CLAUDE_ARC_CRED_FETCH';
const isClaudeAi = host => host === 'claude.ai' || host.endsWith('.claude.ai');

// ─── Service worker side ─────────────────────────────────────────────────────
if (typeof window === 'undefined') {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== MSG) return;

    (async () => {
      try {
        const res = await fetch(msg.url, {
          method: msg.method || 'GET',
          headers: msg.headers,
          body: msg.body,
          credentials: 'include',
          cache: msg.cache || 'default',
          redirect: msg.redirect || 'follow'
        });

        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });

        sendResponse({
          ok: res.ok,
          // A `redirect: 'manual'` hit yields an opaque redirect: status 0,
          // which the Response constructor rejects. 502 preserves what every
          // caller actually branches on (`!ok`, and not 401/403).
          // ponytail: revisit only if something starts reading the raw 0.
          status: res.status === 0 ? 502 : res.status,
          statusText: res.statusText,
          headers,
          body: await res.text()
        });
      } catch (e) {
        sendResponse({ error: String(e?.message || e) });
      }
    })();

    return true; // async sendResponse
  });

  console.log('[Arc Auth Proxy] worker handler ready');
}

// ─── Panel side ──────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && !window.__arcAuthProxy) {
  window.__arcAuthProxy = true;

  const nativeFetch = window.fetch.bind(window);

  const shouldProxy = (url, init) => {
    if ((init?.credentials ?? 'same-origin') !== 'include') return false;
    try { return isClaudeAi(new URL(url, location.href).hostname); }
    catch { return false; }
  };

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const opts = init || (input instanceof Request ? input : undefined);

    if (!url || !shouldProxy(url, opts)) return nativeFetch(input, init);

    // Only plain-string bodies survive structured-message passing; anything
    // else (streams, FormData) falls through untouched rather than being
    // silently mangled.
    const body = opts?.body;
    if (body != null && typeof body !== 'string') return nativeFetch(input, init);

    const headers = {};
    if (opts?.headers) new Headers(opts.headers).forEach((v, k) => { headers[k] = v; });

    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: MSG,
        url: new URL(url, location.href).href,
        method: opts?.method || 'GET',
        headers,
        body,
        cache: opts?.cache,
        redirect: opts?.redirect
      });
    } catch {
      return nativeFetch(input, init); // worker asleep or messaging unavailable
    }

    if (!r || r.error) return nativeFetch(input, init);

    // 204/205/304 must not carry a body.
    const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
    return new Response(nullBody ? null : r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers
    });
  };

  console.log('[Arc Auth Proxy] panel fetch wrapper installed');
}
