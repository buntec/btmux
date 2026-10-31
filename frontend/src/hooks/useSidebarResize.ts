import { useCallback, useState, type RefObject } from 'react';

export const MIN_SIDEBAR_RATIO = 0.2;
export const MAX_SIDEBAR_RATIO = 0.5;

interface ResizeOptions {
  /** `x` resizes width (side-by-side panels), `y` resizes height (stacked panels). */
  axis?: 'x' | 'y';
  min?: number;
  max?: number;
}

/** First-panel size as a ratio of the container, resized by dragging a divider. */
export function useSidebarResize(
  rootRef: RefObject<HTMLElement | null>,
  initialRatio: number,
  { axis = 'x', min = MIN_SIDEBAR_RATIO, max = MAX_SIDEBAR_RATIO }: ResizeOptions = {},
) {
  const [sidebarRatio, setSidebarRatio] = useState(initialRatio);

  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const rootBounds = root.getBoundingClientRect();
      const start = axis === 'x' ? rootBounds.left : rootBounds.top;
      const size = axis === 'x' ? rootBounds.width : rootBounds.height;
      if (size === 0) return;

      const updateSidebarRatio = (event: { clientX: number; clientY: number }) => {
        const ratio = ((axis === 'x' ? event.clientX : event.clientY) - start) / size;
        setSidebarRatio(Math.max(min, Math.min(max, ratio)));
      };

      updateSidebarRatio(e);
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      trackPointerDrag(e, updateSidebarRatio, () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    },
    [rootRef, axis, min, max],
  );

  return { sidebarRatio, onDividerPointerDown };
}

/**
 * Follows a drag that starts with `e` on a divider, with mouse, pen, or touch.
 * The divider needs `touch-action: none`, or touch scrolls instead.
 */
export function trackPointerDrag(
  e: React.PointerEvent,
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent) => void,
) {
  e.preventDefault();
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const end = (event: PointerEvent) => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    onEnd(event);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

/** Widens a thin divider's hit area on touch screens. */
export const DIVIDER_TOUCH_TARGET =
  "touch-none pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:-inset-2 pointer-coarse:before:content-['']";
