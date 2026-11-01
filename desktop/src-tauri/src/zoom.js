// Zoom shortcuts as in browsers: Ctrl+=/+/-/0, or on macOS ⌘+ (⌘⇧= on US
// layouts), which the View menu's ⌘= doesn't match.
{
  const mac = /Mac/.test(navigator.platform);
  const steps = mac ? { '+': 'in' } : { '=': 'in', '+': 'in', '-': 'out', 0: 'reset' };
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey || (mac ? e.ctrlKey || !e.metaKey : e.metaKey || !e.ctrlKey)) return;
      const step = steps[e.key === '=' && e.shiftKey ? '+' : e.key];
      if (!step) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.__TAURI_INTERNALS__?.invoke('zoom', { step }).catch(() => {});
    },
    true,
  );
}
