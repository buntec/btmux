import { LayoutNode, LayoutRect } from './types';

export interface Bounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Divider {
  id: string;
  orientation: 'vertical' | 'horizontal';
  // Position of the divider line as a percentage along the split region's axis
  position: number; // percentage along the container's axis where the split sits
  // Cross-axis span (percentage-based start and size)
  crossStart: number;
  crossSize: number;
  // The split region bounds (for ratio calculation during drag)
  boundsStart: number;
  boundsSize: number;
}

/**
 * Flatten a layout tree to its pane ids in depth-first order (left/top child
 * first), mirroring the backend's `Layout::pane_ids`. This is the same order
 * `computeRectsAndDividers` emits its rects in, so a rect's array index lines up
 * with this list — used to number panes for display-panes.
 */
export function paneIdsInOrder(layout: LayoutNode): string[] {
  switch (layout.type) {
    case 'leaf':
      return layout.pane_id ? [layout.pane_id] : [];
    case 'v_split':
      return [...paneIdsInOrder(layout.left!), ...paneIdsInOrder(layout.right!)];
    case 'h_split':
      return [...paneIdsInOrder(layout.top!), ...paneIdsInOrder(layout.bottom!)];
    default:
      return [];
  }
}

/**
 * Decode a recursive `LayoutNode` tree into percentage-based pane rects plus the
 * divider lines between splits. Shared by SessionPane (the live grid, which uses
 * both rects and dividers) and WindowGrid (thumbnails, which use rects only).
 *
 * `ratioOverrides` maps a split node id to a live drag ratio; pass an empty map
 * to use each split's stored `ratio` (or 0.5 default).
 */
export function computeRectsAndDividers(
  layout: LayoutNode,
  bounds: Bounds,
  ratioOverrides: Map<string, number>,
): { rects: LayoutRect[]; dividers: Divider[] } {
  switch (layout.type) {
    case 'leaf':
      return { rects: [{ paneId: layout.pane_id!, ...bounds }], dividers: [] };

    case 'v_split': {
      const ratio = ratioOverrides.get(layout.id!) ?? layout.ratio ?? 0.5;
      const leftWidth = bounds.width * ratio;
      const rightWidth = bounds.width * (1 - ratio);

      const { rects: lr, dividers: ld } = computeRectsAndDividers(
        layout.left!,
        { ...bounds, width: leftWidth },
        ratioOverrides,
      );
      const { rects: rr, dividers: rd } = computeRectsAndDividers(
        layout.right!,
        { top: bounds.top, left: bounds.left + leftWidth, width: rightWidth, height: bounds.height },
        ratioOverrides,
      );

      const divider: Divider = {
        id: layout.id!,
        orientation: 'vertical',
        position: bounds.left + leftWidth, // % along horizontal axis
        crossStart: bounds.top,
        crossSize: bounds.height,
        boundsStart: bounds.left,
        boundsSize: bounds.width,
      };

      return { rects: [...lr, ...rr], dividers: [...ld, ...rd, divider] };
    }

    case 'h_split': {
      const ratio = ratioOverrides.get(layout.id!) ?? layout.ratio ?? 0.5;
      const topHeight = bounds.height * ratio;
      const bottomHeight = bounds.height * (1 - ratio);

      const { rects: tr, dividers: td } = computeRectsAndDividers(
        layout.top!,
        { ...bounds, height: topHeight },
        ratioOverrides,
      );
      const { rects: br, dividers: bd } = computeRectsAndDividers(
        layout.bottom!,
        { top: bounds.top + topHeight, left: bounds.left, width: bounds.width, height: bottomHeight },
        ratioOverrides,
      );

      const divider: Divider = {
        id: layout.id!,
        orientation: 'horizontal',
        position: bounds.top + topHeight, // % along vertical axis
        crossStart: bounds.left,
        crossSize: bounds.width,
        boundsStart: bounds.top,
        boundsSize: bounds.height,
      };

      return { rects: [...tr, ...br], dividers: [...td, ...bd, divider] };
    }

    default:
      return { rects: [], dividers: [] };
  }
}
