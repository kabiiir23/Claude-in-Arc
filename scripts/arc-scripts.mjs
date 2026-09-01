/**
 * The files this repo injects into the extension's assets/ directory.
 * Single source of truth — the builder copies these, the tests assert on them.
 *
 * Matched by exact name, never by an `arc-` prefix: upstream ships
 * assets/arc-<hash>.js, the shiki grammar for the Arc *lisp* language.
 */
export const ARC_SCRIPTS = [
  'arc-tabgroups.js',
  'arc-auth-proxy.js',
  'arc-sidepanel-shim.js',
  'arc-bridge-interceptor.js',
  'arc-zoom-handler.js',
  'arc-adapter.js',
  'claude-panel-injector.js',
  'viewport-override.js',
  'cmd-e-fallback.js',
  'theme-init.js'
];

/**
 * Service worker import order. `null` is where the official bundle slots in.
 * The tab-groups emulation and sidePanel polyfill must precede it: 1.0.90 reads
 * chrome.tabGroups.Color at module scope and throws on a browser without it.
 */
export const WORKER_IMPORTS = [
  './assets/arc-tabgroups.js',
  './assets/arc-auth-proxy.js',
  './assets/arc-sidepanel-shim.js',
  null,
  './assets/arc-bridge-interceptor.js',
  './assets/arc-zoom-handler.js',
  './assets/arc-adapter.js'
];
