import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { Overlay, PickerItem } from '../state/types';
import { paneIdsInOrder } from '../state/layout';

/** How long the display-panes (prefix + q) number overlay stays up, in ms. */
const DISPLAY_PANES_MS = 1500;
/** Auto-hide timer for the display-panes overlay (module-scoped: one at a time). */
let paneNumbersTimer = 0;

interface ParsedKey {
  ctrl: boolean;
  alt: boolean;
  key: string;
}

function parsePrefix(prefix: string): ParsedKey {
  const parts = prefix.split('-');
  const key = (parts.pop() ?? '').toLowerCase();
  const mods = new Set(parts.map((p) => p.toUpperCase()));
  return { ctrl: mods.has('C'), alt: mods.has('M'), key };
}

function matchesPrefix(e: KeyboardEvent, p: ParsedKey): boolean {
  return e.ctrlKey === p.ctrl && e.altKey === p.alt && e.key.toLowerCase() === p.key;
}

export function useKeybindings(
  sessionId: string,
  send: (msg: ClientMessage) => void,
  onNavigateToLanding: () => void,
  onSwitchToSession: (sessionName: string) => void,
) {
  const config = useStore((s) => s.config);
  const prefixActive = useStore((s) => s.prefixActive);
  const setPrefixActive = useStore((s) => s.setPrefixActive);
  const overlay = useStore((s) => s.overlay);
  const windowGridOpen = useStore((s) => s.windowGridOpen);
  const paneNumbersVisible = useStore((s) => s.paneNumbersVisible);
  const timeoutRef = useRef<number>(0);

  const prefix = useMemo(() => parsePrefix(config?.prefix ?? 'C-b'), [config?.prefix]);
  const binds = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of config?.binds ?? []) map.set(b.key, b.action);
    return map;
  }, [config?.binds]);

  // Keep refs so the single stable listener always reads current values
  // without needing to re-register on every state change.
  const prefixActiveRef = useRef(prefixActive);
  const overlayRef = useRef(overlay);
  const windowGridOpenRef = useRef(windowGridOpen);
  const paneNumbersVisibleRef = useRef(paneNumbersVisible);
  const prefixRef = useRef(prefix);
  const bindsRef = useRef(binds);
  const sessionIdRef = useRef(sessionId);
  const sendRef = useRef(send);
  const onNavigateRef = useRef(onNavigateToLanding);
  const onSwitchToSessionRef = useRef(onSwitchToSession);

  prefixActiveRef.current = prefixActive;
  overlayRef.current = overlay;
  windowGridOpenRef.current = windowGridOpen;
  paneNumbersVisibleRef.current = paneNumbersVisible;
  prefixRef.current = prefix;
  bindsRef.current = binds;
  sessionIdRef.current = sessionId;
  sendRef.current = send;
  onNavigateRef.current = onNavigateToLanding;
  onSwitchToSessionRef.current = onSwitchToSession;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isFKey = e.key.startsWith('F') && e.key.length >= 2 && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)));
      if (e.metaKey || isFKey) {
        e.stopPropagation();
        return;
      }

      if (overlayRef.current) return;
      // While the file browser is open it owns the keyboard.
      if (useStore.getState().fileBrowserOpen) return;
      // While the window-grid is open it owns the keyboard (arrows/enter/esc/
      // digits navigate the grid); don't let the prefix or pane binds fire.
      if (windowGridOpenRef.current) return;

      // While display-panes (prefix + q) numbers are showing, the keyboard is
      // captured: a digit selects the pane with that index, any other key just
      // dismisses the overlay. Either way, swallow the key so it doesn't reach
      // the terminal or fall through to the prefix logic below.
      if (paneNumbersVisibleRef.current) {
        e.preventDefault();
        e.stopPropagation();
        hidePaneNumbers();
        if (e.key >= '0' && e.key <= '9') {
          selectPaneByIndex(sessionIdRef.current, parseInt(e.key, 10), sendRef.current);
        }
        return;
      }

      if (!prefixActiveRef.current && matchesPrefix(e, prefixRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        setPrefixActive(true);
        prefixActiveRef.current = true;
        clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => {
          setPrefixActive(false);
          prefixActiveRef.current = false;
        }, 2000);
        return;
      }

      if (prefixActiveRef.current) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(timeoutRef.current);
        setPrefixActive(false);
        prefixActiveRef.current = false;
        dispatch(
          e,
          sessionIdRef.current,
          bindsRef.current,
          sendRef.current,
          onNavigateRef.current,
          onSwitchToSessionRef.current,
        );
        return;
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
    // Register once — all mutable values are read via refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrefixActive]);
}

function dispatch(
  e: KeyboardEvent,
  sessionId: string,
  binds: Map<string, string>,
  send: (msg: ClientMessage) => void,
  onNavigateToLanding: () => void,
  onSwitchToSession: (sessionName: string) => void,
) {
  if (!binds.has(e.key) && e.key >= '0' && e.key <= '9') {
    send({
      type: 'switch_window',
      session_id: sessionId,
      index: parseInt(e.key, 10),
    });
    return;
  }

  const action = binds.get(e.key);
  if (action) runAction(action, sessionId, send, onNavigateToLanding, onSwitchToSession);
}

function runAction(
  action: string,
  sessionId: string,
  send: (msg: ClientMessage) => void,
  onNavigateToLanding: () => void,
  onSwitchToSession: (sessionName: string) => void,
) {
  const store = useStore.getState();
  const paneId = store.getActivePaneId(sessionId);
  const openOverlay = (o: Overlay) => store.setOverlay(o);
  const session = store.getSession(sessionId);

  switch (action) {
    case 'split-vertical':
      if (paneId)
        send({
          type: 'split',
          session_id: sessionId,
          pane_id: paneId,
          direction: 'v',
        });
      break;
    case 'split-horizontal':
      if (paneId)
        send({
          type: 'split',
          session_id: sessionId,
          pane_id: paneId,
          direction: 'h',
        });
      break;
    case 'navigate-left':
      send({ type: 'navigate', session_id: sessionId, direction: 'left' });
      break;
    case 'navigate-right':
      send({ type: 'navigate', session_id: sessionId, direction: 'right' });
      break;
    case 'navigate-up':
      send({ type: 'navigate', session_id: sessionId, direction: 'up' });
      break;
    case 'navigate-down':
      send({ type: 'navigate', session_id: sessionId, direction: 'down' });
      break;
    case 'kill-pane':
      if (paneId) send({ type: 'kill_pane', session_id: sessionId, pane_id: paneId });
      break;
    case 'zoom-pane':
      if (paneId) send({ type: 'zoom_pane', session_id: sessionId, pane_id: paneId });
      break;
    case 'capture-pane': {
      // Read the active pane's scrollback straight from its ghostty-web buffer
      // (the only place de-escaped, wrapped text exists) and hand it to the
      // backend, which writes it to a temp file and opens it in $EDITOR *inside
      // this pane's own shell* — reusing the live terminal rather than mounting
      // a new one. buffer.active is the alternate screen when a full-screen app
      // is running, so this captures whatever is on the pane's current screen —
      // matching `tmux capture-pane` without `-a`.
      if (!paneId) break;
      const term = store.terminals.get(paneId);
      if (!term) break;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      const content = lines.join('\n').replace(/\n+$/, '') + '\n';
      send({ type: 'capture_pane', pane_id: paneId, content });
      break;
    }
    case 'new-window':
      send({ type: 'create_window', session_id: sessionId });
      break;
    case 'next-window':
      send({ type: 'switch_window', session_id: sessionId, index: -1 });
      break;
    case 'prev-window':
      send({ type: 'switch_window', session_id: sessionId, index: -2 });
      break;
    case 'rename-window': {
      const win = session?.windows[session.active_window];
      openOverlay({
        mode: 'prompt',
        title: 'rename-window',
        value: win?.name ?? '',
        action: 'rename-window',
      });
      break;
    }
    case 'kill-window':
      send({ type: 'close_window', session_id: sessionId });
      break;
    case 'new-session':
      openOverlay({
        mode: 'prompt',
        title: 'new-session',
        value: '',
        action: 'new-session',
      });
      break;
    case 'choose-session':
    case 'choose-tree':
      onNavigateToLanding();
      break;
    case 'window-grid':
      // Mount the grid (sticky) and show it. The WindowGrid component takes over
      // keyboard handling while open (the hook early-returns below).
      store.markWindowGridMounted();
      store.setWindowGridOpen(true);
      break;
    case 'rename-session':
      openOverlay({
        mode: 'prompt',
        title: 'rename-session',
        value: session?.name ?? '',
        action: 'rename-session',
      });
      break;
    case 'kill-session':
      send({ type: 'kill_session', id: sessionId });
      break;
    case 'last-window':
      send({ type: 'last_window', session_id: sessionId });
      break;
    case 'last-session': {
      // Mirror tmux's `switch-client -l`: toggle back to the previously-active
      // session for this tab. Session switching is URL-based (no server-side
      // "current session"), so resolve the remembered name and navigate to it
      // only if that session still exists.
      const prevName = sessionStorage.getItem('btmux-prev-session');
      if (prevName && prevName !== session?.name && store.allSessions.some((s) => s.name === prevName)) {
        onSwitchToSession(prevName);
      }
      break;
    }
    case 'next-pane':
      send({ type: 'cycle_pane', session_id: sessionId, delta: 1 });
      break;
    case 'swap-pane-back':
      send({ type: 'swap_pane', session_id: sessionId, delta: -1 });
      break;
    case 'swap-pane-forward':
      send({ type: 'swap_pane', session_id: sessionId, delta: 1 });
      break;
    case 'next-layout':
      send({ type: 'next_layout', session_id: sessionId });
      break;
    case 'display-panes':
      showPaneNumbers();
      break;
    case 'detach':
      onNavigateToLanding();
      break;
    case 'last-pane':
      send({ type: 'last_pane', session_id: sessionId });
      break;
    case 'list-keys': {
      const binds = store.config?.binds ?? [];
      openOverlay({ mode: 'keys', title: 'Key bindings', binds });
      break;
    }
    case 'command-palette':
      openOverlay({ mode: 'command', title: 'Commands', commands: store.config?.commands ?? [] });
      break;
    case 'choose-colors': {
      const schemes = store.config?.color_schemes ?? [];
      const active = store.config?.active_color_scheme;
      const items: PickerItem[] = [
        { id: '', label: '(none)', active: !active },
        ...schemes.map((s) => ({ id: s, label: s, active: s === active })),
      ];
      openOverlay({
        mode: 'picker',
        title: 'Color scheme',
        items,
        onSelect: (id) => send({ type: 'update_config', update: { colors: id } }),
      });
      break;
    }
    case 'choose-font': {
      const fonts = store.config?.fonts ?? [];
      const currentFamily = store.config?.terminal?.fontFamily ?? 'JetBrains Mono';
      const currentWeight = store.config?.terminal?.fontWeight ?? 200;
      const items: PickerItem[] = fonts.map((f) => ({
        id: `${f.family}:${f.weight_min}`,
        label: `${f.family} (${f.weight_min}–${f.weight_max})`,
        active: f.family === currentFamily,
      }));
      openOverlay({
        mode: 'picker',
        title: `Font (current: ${currentFamily} @ ${currentWeight})`,
        items,
        onSelect: (id) => {
          const [family] = id.split(':');
          send({ type: 'update_config', update: { font_family: family } });
        },
      });
      break;
    }
    case 'choose-font-weight': {
      const fonts = store.config?.fonts ?? [];
      const currentFamily = store.config?.terminal?.fontFamily ?? 'JetBrains Mono';
      const currentWeight = store.config?.terminal?.fontWeight ?? 200;
      const fontInfo = fonts.find((f) => f.family === currentFamily);
      const min = fontInfo?.weight_min ?? 100;
      const max = fontInfo?.weight_max ?? 900;
      const weights: PickerItem[] = [];
      for (let w = min; w <= max; w += 100) {
        weights.push({ id: String(w), label: String(w), active: w === currentWeight });
      }
      openOverlay({
        mode: 'picker',
        title: `Font weight (${currentFamily})`,
        items: weights,
        onSelect: (id) => {
          send({ type: 'update_config', update: { font_weight: parseInt(id, 10) } });
        },
      });
      break;
    }
    case 'file-browser': {
      const win = session?.windows[session.active_window];
      const pane = win?.panes[win.active_pane];
      const cwd = pane?.cwd ?? null;
      store.setFileBrowserOpen(true, cwd);
      break;
    }
  }
}

/** Show the display-panes number overlay and arm its auto-hide timer. */
function showPaneNumbers() {
  const store = useStore.getState();
  store.setPaneNumbersVisible(true);
  clearTimeout(paneNumbersTimer);
  paneNumbersTimer = window.setTimeout(() => {
    useStore.getState().setPaneNumbersVisible(false);
  }, DISPLAY_PANES_MS);
}

/** Hide the display-panes overlay and cancel its auto-hide timer. */
function hidePaneNumbers() {
  clearTimeout(paneNumbersTimer);
  useStore.getState().setPaneNumbersVisible(false);
}

/**
 * Select the active window's pane at layout index `idx` (0-based, matching the
 * numbers display-panes shows). The index is into `paneIdsInOrder` — the same
 * depth-first order the backend and the number overlay use — so it stays correct
 * regardless of how the panes are split.
 */
function selectPaneByIndex(sessionId: string, idx: number, send: (msg: ClientMessage) => void) {
  const session = useStore.getState().getSession(sessionId);
  const window = session?.windows[session.active_window];
  if (!window) return;
  const paneId = paneIdsInOrder(window.layout)[idx];
  if (paneId) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
}
