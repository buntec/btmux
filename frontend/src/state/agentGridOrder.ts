// Per-browser agent grid tile order, persisted in localStorage.

const AGENT_GRID_ORDER_KEY = 'btmux-agent-grid-order';
const MAX_REMEMBERED = 256;

export function getAgentGridOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AGENT_GRID_ORDER_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Saves the shown panes' order; remembered panes not shown now keep their place after them. */
export function saveAgentGridOrder(paneIds: string[]): string[] {
  const shown = new Set(paneIds);
  const order = [...paneIds, ...getAgentGridOrder().filter((id) => !shown.has(id))].slice(0, MAX_REMEMBERED);
  try {
    localStorage.setItem(AGENT_GRID_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Storage unavailable: the order lasts until reload.
  }
  return order;
}

/** Remembered panes first, in saved order; the rest keep their relative order after them. */
export function sortByAgentGridOrder<T>(items: T[], paneId: (item: T) => string, order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const key = (item: T) => rank.get(paneId(item)) ?? order.length;
  return [...items].sort((a, b) => key(a) - key(b));
}

/** Returns `ids` with the item at `from` moved to `to`. */
export function moveId(ids: string[], from: number, to: number): string[] {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
