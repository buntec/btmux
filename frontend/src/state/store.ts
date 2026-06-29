import { create } from 'zustand';
import { toast } from 'sonner';
import type { Terminal } from 'ghostty-web';
import { SessionState, SessionSummary, ClientConfig, Overlay } from './types';
import type { NotificationLevel } from '../protocol/messages';

export interface PaneNotification {
  paneId: string;
  event: string;
  level: NotificationLevel;
  title: string | null;
  body: string | null;
  timestamp: number;
}

interface AppStore {
  // All sessions from server (broadcast to all tabs)
  sessions: SessionSummary[];
  allSessions: SessionState[];
  config: ClientConfig | null;
  prefixActive: boolean;
  overlay: Overlay | null;
  // Window-grid (prefix + w) visibility. `windowGridMounted` flips true on first
  // open and stays true (sticky) so the grid's live thumbnail mirrors keep
  // streaming + suspend()ed in the background — reopening is then instant, the
  // same lazy-but-sticky warmth SessionPane uses for windows. `windowGridOpen`
  // toggles which is shown vs display:none.
  windowGridOpen: boolean;
  windowGridMounted: boolean;
  // display-panes (prefix + q): briefly overlays each pane's index on the active
  // window. While true the keybinding hook captures digit presses to select a
  // pane by number (and any other key dismisses it); it auto-hides on a timer.
  paneNumbersVisible: boolean;
  // File browser overlay (prefix + f)
  fileBrowserOpen: boolean;
  fileBrowserCwd: string | null;
  // Whether the /ws/control socket is currently connected. The frontend holds
  // no canonical state, so while this is false the UI is showing stale data.
  controlConnected: boolean;
  // Live ghostty-web Terminal per mounted pane, registered by TerminalPane.
  // Non-reactive (mutated in place, nothing subscribes): it exists so actions
  // that run outside the pane tree — e.g. capture-pane in useKeybindings — can
  // read a pane's emulator buffer. SessionPane's registryRef is for focus only.
  terminals: Map<string, Terminal>;
  // Per-pane notifications from external tools (Claude Code hooks, etc.).
  // Keyed by pane ID; cleared when the user focuses the pane.
  notifications: Map<string, PaneNotification>;
  // Router navigate fn, registered by AppInner (which lives inside <BrowserRouter>).
  // Lets code outside the router — the control socket's OS-notification onclick —
  // do SPA navigation. Non-reactive (set once, read on demand).
  navigateFn: ((path: string) => void) | null;
  setSessions: (sessions: SessionSummary[]) => void;
  setAllSessions: (allSessions: SessionState[]) => void;
  setConfig: (config: ClientConfig) => void;
  setControlConnected: (connected: boolean) => void;
  registerTerminal: (paneId: string, term: Terminal) => void;
  unregisterTerminal: (paneId: string, term: Terminal) => void;
  setPrefixActive: (active: boolean) => void;
  setOverlay: (overlay: Overlay | null) => void;
  setWindowGridOpen: (open: boolean) => void;
  markWindowGridMounted: () => void;
  setPaneNumbersVisible: (visible: boolean) => void;
  showToast: (message: string, level?: 'info' | 'error', opts?: { body?: string; paneId?: string }) => void;
  setPaneNotification: (n: PaneNotification) => void;
  clearPaneNotification: (paneId: string) => void;
  setFileBrowserOpen: (open: boolean, cwd?: string | null) => void;
  setNavigateFn: (fn: (path: string) => void) => void;
  // Navigate to the window containing a pane, if it can be located.
  navigateToPane: (paneId: string) => void;
  // Derive a session snapshot by id from allSessions
  getSession: (sessionId: string) => SessionState | null;
  getActivePaneId: (sessionId: string) => string | null;
}

export const useStore = create<AppStore>((set, get) => ({
  sessions: [],
  allSessions: [],
  config: null,
  prefixActive: false,
  overlay: null,
  windowGridOpen: false,
  windowGridMounted: false,
  paneNumbersVisible: false,
  fileBrowserOpen: false,
  fileBrowserCwd: null,
  controlConnected: false,
  terminals: new Map(),
  notifications: new Map(),
  navigateFn: null,
  setSessions: (sessions) => set({ sessions }),
  setAllSessions: (allSessions) => set({ allSessions }),
  setConfig: (config) => {
    set({ config });
    if (config?.theme) {
      try {
        localStorage.setItem('btmux-theme', JSON.stringify(config.theme));
      } catch {}
    }
  },
  setControlConnected: (connected) => set({ controlConnected: connected }),
  registerTerminal: (paneId, term) => get().terminals.set(paneId, term),
  // Guard against a stale unmount clobbering a remounted pane's entry: only
  // delete if the registered Terminal is still the one being torn down.
  unregisterTerminal: (paneId, term) => {
    const map = get().terminals;
    if (map.get(paneId) === term) map.delete(paneId);
  },
  setPrefixActive: (active) => set({ prefixActive: active }),
  setOverlay: (overlay) => set({ overlay }),
  setFileBrowserOpen: (open, cwd) => set({ fileBrowserOpen: open, fileBrowserCwd: cwd ?? null }),
  setWindowGridOpen: (open) => set({ windowGridOpen: open }),
  markWindowGridMounted: () => set((s) => (s.windowGridMounted ? s : { windowGridMounted: true })),
  setPaneNumbersVisible: (visible) => set({ paneNumbersVisible: visible }),
  showToast: (message, level, opts) => {
    const emit = level === 'error' ? toast.error : toast.info;
    const paneId = opts?.paneId;
    emit(message, {
      description: opts?.body,
      duration: level === 'error' ? 8000 : 5000,
      // Preserve the old click-to-navigate behavior: jump to the pane that
      // raised the toast. Exposed as an explicit "View" action so the rest of
      // the toast stays dismiss-only.
      action: paneId ? { label: 'View', onClick: () => get().navigateToPane(paneId) } : undefined,
    });
  },
  setPaneNotification: (n) =>
    set((s) => {
      const next = new Map(s.notifications);
      next.set(n.paneId, n);
      return { notifications: next };
    }),
  clearPaneNotification: (paneId) =>
    set((s) => {
      if (!s.notifications.has(paneId)) return s;
      const next = new Map(s.notifications);
      next.delete(paneId);
      return { notifications: next };
    }),
  setNavigateFn: (fn) => set({ navigateFn: fn }),
  navigateToPane: (paneId) => {
    const { allSessions, navigateFn } = get();
    if (!navigateFn) return;
    for (const session of allSessions) {
      for (const win of session.windows) {
        if (win.panes.some((p) => p.id === paneId)) {
          navigateFn(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(win.name)}`);
          return;
        }
      }
    }
  },
  getSession: (sessionId) => {
    return get().allSessions.find((s) => s.id === sessionId) ?? null;
  },
  getActivePaneId: (sessionId) => {
    const session = get().allSessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const window = session.windows[session.active_window];
    if (!window) return null;
    return window.panes[window.active_pane]?.id ?? null;
  },
}));
