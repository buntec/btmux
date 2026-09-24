import { useCallback, useState, type RefObject } from 'react';

export const MIN_SIDEBAR_RATIO = 0.2;
export const MAX_SIDEBAR_RATIO = 0.5;

/** Sidebar width as a ratio of the root, resized by dragging a divider. */
export function useSidebarResize(rootRef: RefObject<HTMLElement | null>, initialRatio: number) {
  const [sidebarRatio, setSidebarRatio] = useState(initialRatio);

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const root = rootRef.current;
      if (!root) return;

      const rootBounds = root.getBoundingClientRect();
      if (rootBounds.width === 0) return;

      const updateSidebarRatio = (clientX: number) => {
        const ratio = (clientX - rootBounds.left) / rootBounds.width;
        setSidebarRatio(Math.max(MIN_SIDEBAR_RATIO, Math.min(MAX_SIDEBAR_RATIO, ratio)));
      };

      const onMouseMove = (ev: MouseEvent) => updateSidebarRatio(ev.clientX);
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      updateSidebarRatio(e.clientX);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [rootRef],
  );

  return { sidebarRatio, onDividerMouseDown };
}
