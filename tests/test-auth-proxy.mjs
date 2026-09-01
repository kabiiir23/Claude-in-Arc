/**
 * arc-auth-proxy: the panel's credentialed claude.ai fetches must go through
 * the service worker (which gets first-party cookies), and NOTHING else may be
 * touched — the Bearer-token calls to api.anthropic.com include streaming.
 *
 * Run: node tests/test-auth-proxy.mjs
 */
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './_bundles.mjs';

const SRC = join(ROOT, 'arc', 'arc-auth-proxy.js');
const HERE = dirname(fileURLToPath(import.meta.url));

// The file has no import/export (so it loads in both contexts), which makes
// Node cache it as CJS. Copy per context to get a fresh instance.
let n = 0;
async function loadFresh() {
  const tmp = join(HERE, `.proxy-${Date.now()}-${n++}.mjs`);
  copyFileSync(SRC, tmp);
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

// ─── Worker side ─────────────────────────────────────────────────────────────
let workerListener;
const workerFetches = [];
let nextResponse = () => new Response('{"account":{"uuid":"abc"}}', {
  status: 200, headers: { 'content-type': 'application/json' }
});

delete globalThis.window;
globalThis.chrome = {
  runtime: { id: 'x', onMessage: { addListener: fn => { workerListener = fn; } } }
};
globalThis.fetch = async (url, init) => { workerFetches.push({ url, init }); return nextResponse(); };
await loadFresh();

await check('worker: registers a message handler', () => {
  assert.equal(typeof workerListener, 'function');
});

await check('worker: performs the fetch with credentials and returns the body', async () => {
  const reply = await new Promise(res => {
    workerListener({ type: 'CLAUDE_ARC_CRED_FETCH', url: 'https://claude.ai/api/bootstrap', cache: 'no-store', redirect: 'manual' }, {}, res);
  });
  assert.equal(workerFetches.at(-1).init.credentials, 'include', 'worker must send cookies');
  assert.equal(workerFetches.at(-1).init.cache, 'no-store', 'cache mode must be preserved');
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).account.uuid, 'abc');
  assert.equal(reply.headers['content-type'], 'application/json');
});

await check('worker: opaque redirect (status 0) becomes a non-ok status', async () => {
  nextResponse = () => Object.assign(new Response(null, { status: 200 }), {});
  const fake = { ok: false, status: 0, statusText: '', headers: new Headers(), text: async () => '' };
  globalThis.fetch = async () => fake;
  const reply = await new Promise(res => {
    workerListener({ type: 'CLAUDE_ARC_CRED_FETCH', url: 'https://claude.ai/api/bootstrap' }, {}, res);
  });
  assert.equal(reply.ok, false);
  assert.notEqual(reply.status, 0, 'status 0 would throw in the Response constructor');
  assert.equal(reply.status >= 400, true);
});

await check('worker: reports fetch failures instead of hanging', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const reply = await new Promise(res => {
    workerListener({ type: 'CLAUDE_ARC_CRED_FETCH', url: 'https://claude.ai/api/bootstrap' }, {}, res);
  });
  assert.match(reply.error, /offline/);
});

// ─── Panel side ──────────────────────────────────────────────────────────────
const native = [];
const sent = [];
let sendReply = async () => ({
  ok: true, status: 200, statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"account":{"uuid":"abc"}}'
});

globalThis.window = globalThis;
globalThis.location = { href: 'chrome-extension://x/sidepanel.html' };
const pageFetch = async (input, init) => { native.push({ input, init }); return new Response('native'); };
globalThis.fetch = pageFetch;
globalThis.chrome = {
  runtime: { id: 'x', onMessage: { addListener() {} }, sendMessage: async m => { sent.push(m); return sendReply(m); } }
};
await loadFresh();

await check('panel: wraps fetch', () => {
  assert.notEqual(globalThis.fetch, pageFetch, 'fetch should have been replaced by the wrapper');
  assert.equal(globalThis.__arcAuthProxy, true);
});

await check('panel: credentialed claude.ai request is proxied', async () => {
  sent.length = 0; native.length = 0;
  const r = await fetch('https://claude.ai/api/bootstrap', { credentials: 'include', cache: 'no-store', redirect: 'manual' });
  assert.equal(sent.length, 1, 'should have gone through the worker');
  assert.equal(native.length, 0, 'must not have hit the page fetch');
  assert.equal(sent[0].url, 'https://claude.ai/api/bootstrap');
  assert.equal(sent[0].cache, 'no-store');
  const j = await r.json();
  assert.equal(j.account.uuid, 'abc', 'body must round-trip');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
});

await check('panel: subdomains of claude.ai are proxied too', async () => {
  sent.length = 0;
  await fetch('https://api.claude.ai/api/bootstrap', { credentials: 'include' });
  assert.equal(sent.length, 1);
});

await check('panel: api.anthropic.com is NOT proxied (Bearer + streaming path)', async () => {
  sent.length = 0; native.length = 0;
  await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { Authorization: 'Bearer x' }, credentials: 'include'
  });
  assert.equal(sent.length, 0, 'anthropic API must never be routed through the worker');
  assert.equal(native.length, 1);
});

await check('panel: claude.ai WITHOUT credentials is NOT proxied', async () => {
  sent.length = 0; native.length = 0;
  await fetch('https://claude.ai/api/something');
  assert.equal(sent.length, 0);
  assert.equal(native.length, 1);
});

await check('panel: non-string bodies fall through untouched', async () => {
  sent.length = 0; native.length = 0;
  await fetch('https://claude.ai/api/upload', {
    method: 'POST', credentials: 'include', body: new Uint8Array([1, 2, 3])
  });
  assert.equal(sent.length, 0, 'binary body must not be mangled by message passing');
  assert.equal(native.length, 1);
});

await check('panel: falls back to native fetch when the worker is unreachable', async () => {
  sent.length = 0; native.length = 0;
  const prev = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async () => { throw new Error('worker asleep'); };
  const r = await fetch('https://claude.ai/api/bootstrap', { credentials: 'include' });
  assert.equal(native.length, 1, 'must fall back rather than throw');
  assert.equal(await r.text(), 'native');
  chrome.runtime.sendMessage = prev;
});

await check('panel: 204 responses carry no body', async () => {
  sendReply = async () => ({ ok: true, status: 204, statusText: 'No Content', headers: {}, body: '' });
  const r = await fetch('https://claude.ai/api/x', { credentials: 'include' });
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
});

let failed = 0;
for (const [s, nm, m] of results) {
  if (s === 'FAIL') failed++;
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${nm}${m ? `\n        ${m}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
