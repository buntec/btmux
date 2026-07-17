// Per-window most-recently-viewed order, persisted in localStorage. Mirrors the
// session-level MRU in LandingPage (`recordMruVisit`), but keyed by window id and
// spanning all sessions — it drives the window-grid (prefix + w) ordering.
// Window ids are globally-unique UUIDs, so a single flat list across sessions is
// collision-free. Stale ids (closed windows) are tolerated: the grid filters the
// order against the live session list before rendering.

import { WindowState, WindowSort } from './types';

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
  // Notify live listeners (e.g. the always-visible StatusBar) so an `mru` window
  // sort re-orders immediately, not just on the next server push. localStorage's
  // `storage` event only fires cross-tab, so we dispatch our own same-tab event.
  window.dispatchEvent(new Event(WINDOW_MRU_EVENT));
}

/** Event name dispatched on the window MRU changing; StatusBar subscribes. */
export const WINDOW_MRU_EVENT = 'btmux-window-mru-change';

/** A window paired with its stable backend index (its position in the server's
 *  `session.windows`). Sorting is display-only, so `switch_window` still needs
 *  the original index — carrying it here keeps the two in sync. */
export interface OrderedWindow<W> {
  win: W;
  /** Position in the backend's window array — the `switch_window` index. */
  index: number;
}

/**
 * Order a session's windows for display per `sort`, pairing each with its
 * original backend index. `created` (default) preserves the server order; `mru`
 * puts the most-recently-visited windows first (unseen windows keep their
 * relative order after those); `alphabetical` sorts by name. Ties and unknown
 * sorts fall back to backend order, so the result is always a stable permutation.
 */
export function sortWindows<W extends WindowState>(windows: W[], sort: WindowSort | string): OrderedWindow<W>[] {
  const paired: OrderedWindow<W>[] = windows.map((win, index) => ({ win, index }));
  if (sort === 'alphabetical') {
    return [...paired].sort((a, b) => a.win.name.localeCompare(b.win.name) || a.index - b.index);
  }
  if (sort === 'mru') {
    const order = getWindowMruOrder();
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? Infinity : i;
    };
    return [...paired].sort((a, b) => rank(a.win.id) - rank(b.win.id) || a.index - b.index);
  }
  return paired;
}
