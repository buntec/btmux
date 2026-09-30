import { useStore } from '../state/store';

/** Open file mode; if the pane runs Neovim, start in the current buffer's directory focused on it. */
export async function openFileBrowserFiles(paneId: string | null, cwd: string | null) {
  let dir = cwd;
  let focus: string | null = null;
  if (paneId) {
    try {
      const res = await fetch(`/api/panes/${encodeURIComponent(paneId)}/editor-file`, { cache: 'no-store' });
      const path: string | null = res.ok ? ((await res.json()) as { path: string | null }).path : null;
      const slash = path ? path.lastIndexOf('/') : -1;
      if (path && slash >= 0) {
        dir = path.slice(0, slash) || '/';
        focus = path.slice(slash + 1);
      }
    } catch {
      // fall back to the pane cwd
    }
  }
  useStore.getState().setFileBrowserOpen(true, dir, paneId, 'files', focus);
}
