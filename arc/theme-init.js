(function () {
  // 1.0.90 ships sidepanel.html/options.html with data-mode="light" hardcoded,
  // so this has to override the attribute rather than merely set it. Runs as a
  // classic script before the deferred module bundles, i.e. before first paint.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = dark =>
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');

  apply(mq.matches);
  mq.addEventListener('change', e => apply(e.matches));
})();
