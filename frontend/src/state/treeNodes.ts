import { SessionState, TreeNode, WindowSort } from './types';
import { sortWindows } from './windowMru';

export function buildTreeNodes(
  allSessions: SessionState[],
  currentSessionId: string | null,
  windowSort: WindowSort | string = 'created',
  currentWindowIndex?: number,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const sess of allSessions) {
    const sessActive = sess.id === currentSessionId;
    nodes.push({ kind: 'session', id: sess.id, name: sess.name });
    // Windows are shown in the configured display order; each carries its stable
    // backend index (for switch_window) plus its display position (the number
    // shown and the hotkey), so both stay consistent with the ordering.
    sortWindows(sess.windows, windowSort).forEach(({ win, index: wi }, displayIndex) => {
      const winActive = sessActive && wi === (currentWindowIndex ?? sess.active_window);
      nodes.push({
        kind: 'window',
        id: win.id,
        sessionId: sess.id,
        sessionName: sess.name,
        name: win.name,
        index: wi,
        displayIndex,
        active: winActive,
      });
      for (let pi = 0; pi < win.panes.length; pi++) {
        const pane = win.panes[pi];
        nodes.push({
          kind: 'pane',
          id: pane.id,
          sessionId: sess.id,
          sessionName: sess.name,
          windowId: win.id,
          index: pi,
          active: winActive && pi === win.active_pane,
          title: pane.title ?? null,
          cwd: pane.cwd ?? null,
        });
      }
    });
  }
  return nodes;
}
