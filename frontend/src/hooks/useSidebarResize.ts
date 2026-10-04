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

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
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

      const onMouseMove = (ev: MouseEvent) => updateSidebarRatio(ev);
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      updateSidebarRatio(e);
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [rootRef, axis, min, max],
  );

  return { sidebarRatio, onDividerMouseDown };
}
