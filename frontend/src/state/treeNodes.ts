import { SessionState, TreeNode } from './types';

export function buildTreeNodes(
  allSessions: SessionState[],
  currentSessionId: string | null,
  currentWindowIndex?: number,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const sess of allSessions) {
    const sessActive = sess.id === currentSessionId;
    nodes.push({ kind: 'session', id: sess.id, name: sess.name });
    for (let wi = 0; wi < sess.windows.length; wi++) {
      const win = sess.windows[wi];
      const winActive = sessActive && wi === (currentWindowIndex ?? sess.active_window);
      nodes.push({
        kind: 'window',
        id: win.id,
        sessionId: sess.id,
        sessionName: sess.name,
        name: win.name,
        index: wi,
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
    }
  }
  return nodes;
}
