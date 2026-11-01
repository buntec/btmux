// Ctrl+=/-/0 zoom the page, as in browsers (the macOS View menu has ⌘ ones).
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const step = { '=': 'in', '+': 'in', '-': 'out', '0': 'reset' }[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TAURI_INTERNALS__?.invoke('zoom', { step }).catch(() => {});
  },
  true,
);
