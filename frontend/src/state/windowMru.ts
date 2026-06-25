// Per-window most-recently-viewed order, persisted in localStorage. Mirrors the
// session-level MRU in LandingPage (`recordMruVisit`), but keyed by window id and
// spanning all sessions — it drives the window-grid (prefix + w) ordering.
// Window ids are globally-unique UUIDs, so a single flat list across sessions is
// collision-free. Stale ids (closed windows) are tolerated: the grid filters the
// order against the live session list before rendering.

const WINDOW_MRU_KEY = 'btmux-window-mru';

export function getWindowMruOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WINDOW_MRU_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordWindowMruVisit(windowId: string): void {
  const order = getWindowMruOrder().filter((id) => id !== windowId);
  order.unshift(windowId);
  // Cap the stored history so it can't grow without bound as windows churn.
  localStorage.setItem(WINDOW_MRU_KEY, JSON.stringify(order.slice(0, 64)));
}
