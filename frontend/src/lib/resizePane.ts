import type { LayoutNode } from '../state/types';
import { computeRectsAndDividers } from '../state/layout';

export type ResizeDirection = 'left' | 'right' | 'up' | 'down';

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

interface Step {
  id: string;
  vertical: boolean;
  ratio: number;
  inFirst: boolean;
}

/** Splits enclosing `paneId`, nearest first. */
function ancestors(layout: LayoutNode, paneId: string): Step[] | null {
  if (layout.type === 'leaf') return layout.pane_id === paneId ? [] : null;
  const vertical = layout.type === 'v_split';
  const [first, second] = vertical ? [layout.left, layout.right] : [layout.top, layout.bottom];
  for (const [child, inFirst] of [
    [first, true],
    [second, false],
  ] as const) {
    const path = ancestors(child, paneId);
    if (path) return [...path, { id: layout.id, vertical, ratio: layout.ratio, inFirst }];
  }
  return null;
}

/**
 * tmux resize-pane: move the pane's edge in `direction` by `cells`. The edge is
 * a divider of the nearest enclosing split on that axis with the pane on the
 * matching side; failing that, the nearest split on the axis moves instead.
 * `size` is the pane's current terminal size, used to convert cells to a ratio.
 * `pending` holds ratios sent but not yet echoed by the server, so rapid
 * repeats build on each other instead of the stale layout.
 */
export function resizeRatio(
  layout: LayoutNode,
  paneId: string,
  direction: ResizeDirection,
  cells: number,
  size: { cols: number; rows: number },
  pending?: ReadonlyMap<string, number>,
): { splitId: string; ratio: number } | null {
  const vertical = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  const onAxis = (ancestors(layout, paneId) ?? []).filter((s) => s.vertical === vertical);
  const split = onAxis.find((s) => s.inFirst === forward) ?? onAxis[0];
  if (!split) return null;

  const full = { top: 0, left: 0, width: 100, height: 100 };
  const { rects, dividers } = computeRectsAndDividers(layout, full, new Map());
  const rect = rects.find((r) => r.paneId === paneId);
  const divider = dividers.find((d) => d.id === split.id);
  const cellCount = vertical ? size.cols : size.rows;
  const paneSpan = vertical ? rect?.width : rect?.height;
  if (!rect || !divider || !paneSpan || cellCount <= 0) return null;

  const percentPerCell = paneSpan / cellCount;
  const delta = (cells * percentPerCell) / divider.boundsSize;
  const ratio = (pending?.get(split.id) ?? split.ratio) + (forward ? delta : -delta);
  return { splitId: split.id, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) };
}
