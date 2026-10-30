import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PaneTerminal as Terminal } from '../lib/paneTerminal';
import { Dialog } from '@astryxdesign/core/Dialog';
import { TerminalPane } from './TerminalPane';
import { FileBrowserOverlay } from './FileBrowserOverlay';
import { ProcessOverlay } from './ProcessOverlay';
import { ClientConfig, LayoutRect } from '../state/types';
import { computeRectsAndDividers, paneIdsInOrder, Divider } from '../state/layout';
import { ClientMessage } from '../protocol/messages';
import { useStore } from '../state/store';
import { STARTUP_THEME } from '../state/startupTheme';
import { recordWindowMruVisit } from '../state/windowMru';
import { useWindowAttended } from '../lib/windowAttention';
import { NARROW_QUERY } from '../lib/touch';
import { useMediaQuery } from '@astryxdesign/core/hooks';

interface Props {
  sessionId: string;
  /**
   * Whether this session is the one currently shown. SessionPane renders a
   * TerminalPane for *every* pane across *all* windows of its session (the
   * keep-alive pool) and shows them only while this is the active session *and*
   * the pane is in its active window; everything else stays mounted-but-hidden
   * so switches don't tear down and rebuild emulators.
   *
   * SessionPool mounts one SessionPane per pooled session (keyed by sessionId)
   * and keeps it mounted across session switches, so the keep-alive pool now
   * spans the last-N sessions, not just one. Reading the session's own state
   * from the store (rather than via props) lets a pooled-but-inactive session
   * keep re-rendering as the server pushes window/pane changes.
   */
  isActiveSession: boolean;
  /** Draft config applied locally to this active session while settings are open. */
  previewConfig: ClientConfig | null;
  send: (msg: ClientMessage) => void;
}

export function SessionPane({ sessionId, isActiveSession, previewConfig, send }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratioOverrides, setRatioOverrides] = useState<Map<string, number>>(new Map());
  const overlay = useStore((s) => s.overlay);
  const windowGridOpen = useStore((s) => s.windowGridOpen);
  const agentGridOpen = useStore((s) => s.agentGridOpen);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paneNumbersVisible = useStore((s) => s.paneNumbersVisible);
  const fileBrowserOpen = useStore((s) => s.fileBrowserOpen);
  const nvimPaneId = useStore((s) => (s.nvimOpen ? s.nvimPaneId : null));
  const vscodePaneId = useStore((s) => (s.vscodeOpen ? s.vscodePaneId : null));
  const fileBrowserPaneId = useStore((s) => s.fileBrowserPaneId);
  const fileBrowserCwd = useStore((s) => s.fileBrowserCwd);
  const fileBrowserMode = useStore((s) => s.fileBrowserInitialMode);
  const storeConfig = useStore((s) => s.config);
  const config = previewConfig ?? storeConfig;

  // Read this session's own state from the store. Subscribing to allSessions
  // (rather than receiving windows via props) means a pooled-but-inactive
  // session keeps re-rendering as the server pushes window/pane changes, so its
  // pool stays current and a switch-back shows up-to-date layout immediately.
  const session = useStore((s) => s.allSessions.find((sess) => sess.id === sessionId));
  const windows = session?.windows ?? [];
  const activeWindow = session ? windows[session.active_window] : undefined;
  const activePaneId = activeWindow?.panes[activeWindow.active_pane]?.id ?? null;
  // Narrow screens show only the active pane, as if zoomed (locally).
  const narrow = useMediaQuery(NARROW_QUERY);
  const zoomedPaneId =
    activeWindow?.zoomed_pane ?? (narrow && (activeWindow?.panes.length ?? 0) > 1 ? activePaneId : null);
  const focusedPane = activeWindow?.panes.find((pane) => pane.id === (zoomedPaneId ?? activePaneId));
  const focusedAgentState = focusedPane?.agent_status.state ?? null;
  const focusedUnread = focusedPane?.unread != null;
  const attended = useWindowAttended();

  // Lazy-but-sticky pool membership. We don't mount *every* window's panes the
  // instant a session is entered — that would just move the mount-cost burst to
  // session entry. Instead a window joins the pool the first time it becomes
  // active and then stays (its panes keep streaming, paused, off-screen).
  // So the first switch to a never-seen window costs the same as today; every
  // switch back is instant. Keyed by window id (stable across reorders).
  const [mountedWindowIds, setMountedWindowIds] = useState<Set<string>>(
    () => new Set(activeWindow ? [activeWindow.id] : []),
  );
  useEffect(() => {
    if (!activeWindow || mountedWindowIds.has(activeWindow.id)) return;
    setMountedWindowIds((prev) => new Set(prev).add(activeWindow.id));
  }, [activeWindow?.id]);

  // Record window-level MRU as the active window changes, but only for the shown
  // session — a pooled background session keeps re-rendering on server pushes and
  // must not reorder the grid. This is the one place "the active window of the
  // active session" is observed, so it's the natural recording point.
  useEffect(() => {
    if (isActiveSession && activeWindow) recordWindowMruVisit(activeWindow.id);
  }, [isActiveSession, activeWindow?.id]);

  // Shared map of every mounted pane's Terminal. Each TerminalPane registers
  // itself here on mount and removes itself on unmount.
  const registryRef = useRef<Map<string, Terminal>>(new Map());

  // Authoritatively focus the active pane after the active pane / layout
  // changes, after all child TerminalPane effects (splits, pane navigation,
  // window switches). A pane that is still opening focuses itself once its
  // replay is shown (TerminalPane's focus effect).
  // While a pane is zoomed it is the one shown and must hold focus, even though
  // the covered panes stay mounted — focus it instead of the active pane.
  // Gated on isActiveSession: with the pool now spanning several sessions, N
  // SessionPanes coexist and only the visible one may grab keyboard focus —
  // otherwise a background session's panes would steal it on every server push.
  // Switching sessions flips isActiveSession→true here, re-running this effect
  // so the newly-shown session re-asserts focus.
  // A config update also rebuilds every Terminal (see TerminalPane's termOptions
  // effect), so re-run for it even when activePaneId is unchanged.
  // While a modal is open it owns the keyboard, so don't focus a pane. The
  // window grid, agent grid, and switcher dialogs stay mounted and close in
  // their own effect, which keeps the pane inert here and then restores focus
  // to <body> (TerminalPane blurred before they opened), so focus after it.
  const dialogOpen = windowGridOpen || agentGridOpen || switcherOpen;
  const prevDialogOpen = useRef(dialogOpen);
  useEffect(() => {
    const dialogClosed = prevDialogOpen.current && !dialogOpen;
    prevDialogOpen.current = dialogOpen;
    const focusId = zoomedPaneId ?? activePaneId;
    // Don't steal focus into the terminal while the file browser occupies that pane.
    const browserOwnsActivePane = fileBrowserOpen && fileBrowserPaneId === focusId;
    // Neovim takes focus itself when it covers the active pane.
    const nvimOwnsActivePane = nvimPaneId === focusId || vscodePaneId === focusId;
    if (
      settingsOpen ||
      overlay ||
      windowGridOpen ||
      agentGridOpen ||
      switcherOpen ||
      browserOwnsActivePane ||
      nvimOwnsActivePane ||
      !focusId ||
      !isActiveSession
    ) {
      return;
    }
    // A hidden or unfocused tab must not mark the pane as seen.
    if (attended && (focusedUnread || focusedAgentState === 'done')) {
      send({ type: 'acknowledge_pane', pane_id: focusId });
    }
    registryRef.current.get(focusId)?.focus();
    if (dialogClosed) {
      const id = window.setTimeout(() => registryRef.current.get(focusId)?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [
    activePaneId,
    zoomedPaneId,
    overlay,
    windowGridOpen,
    agentGridOpen,
    switcherOpen,
    fileBrowserOpen,
    fileBrowserPaneId,
    nvimPaneId,
    vscodePaneId,
    isActiveSession,
    settingsOpen,
    previewConfig,
    focusedAgentState,
    focusedUnread,
    attended,
    send,
    config,
  ]);

  const handleDividerMouseDown = useCallback(
    (divider: Divider, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const container = containerRef.current;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const isVertical = divider.orientation === 'vertical';

      const computeRatio = (clientX: number, clientY: number): number => {
        const containerSize = isVertical ? containerRect.width : containerRect.height;
        const mousePos = isVertical ? clientX - containerRect.left : clientY - containerRect.top;
        const mousePct = (mousePos / containerSize) * 100;
        const ratio = (mousePct - divider.boundsStart) / divider.boundsSize;
        return Math.max(0.05, Math.min(0.95, ratio));
      };

      const onMouseMove = (moveEvent: MouseEvent) => {
        const ratio = computeRatio(moveEvent.clientX, moveEvent.clientY);
        setRatioOverrides((prev) => new Map(prev).set(divider.id, ratio));
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const ratio = computeRatio(upEvent.clientX, upEvent.clientY);
        send({ type: 'resize_split', session_id: sessionId, split_id: divider.id, ratio });

        setRatioOverrides((prev) => {
          const next = new Map(prev);
          next.delete(divider.id);
          return next;
        });
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [sessionId, send],
  );

  // Lay out only the active window. Panes of other windows are kept mounted but
  // hidden, so they need no rect of their own.
  const { rects, dividers } = activeWindow
    ? computeRectsAndDividers(activeWindow.layout, { top: 0, left: 0, width: 100, height: 100 }, ratioOverrides)
    : { rects: [], dividers: [] };
  const rectByPane = new Map(rects.map((r) => [r.paneId, r]));
  const HIDDEN: LayoutRect = { paneId: '', top: 0, left: 0, width: 100, height: 100 };

  // display-panes (prefix + q): map each pane id to its layout-order index, the
  // number shown over it and the digit that selects it (see useKeybindings).
  const paneNumberById = new Map(
    activeWindow ? paneIdsInOrder(activeWindow.layout).map((id, i) => [id, i] as const) : [],
  );
  const showPaneNumbers = isActiveSession && paneNumbersVisible && !zoomedPaneId;

  // Place the Neovim and VS Code surfaces over their panes while this session is shown.
  const pinnedRect = (paneId: string | null): LayoutRect | null =>
    paneId === null
      ? null
      : zoomedPaneId
        ? zoomedPaneId === paneId
          ? { ...HIDDEN, paneId }
          : null
        : (rectByPane.get(paneId) ?? null);
  const nvimRect = pinnedRect(nvimPaneId);
  useLayoutEffect(() => {
    if (isActiveSession) useStore.getState().setNvimRect(nvimRect);
  }, [isActiveSession, nvimRect?.paneId, nvimRect?.top, nvimRect?.left, nvimRect?.width, nvimRect?.height]);
  const vscodeRect = pinnedRect(vscodePaneId);
  useLayoutEffect(() => {
    if (isActiveSession) useStore.getState().setVscodeRect(vscodeRect);
  }, [isActiveSession, vscodeRect?.paneId, vscodeRect?.top, vscodeRect?.left, vscodeRect?.width, vscodeRect?.height]);

  // The keep-alive pool: one TerminalPane per pane across *every* window of the
  // session, keyed by paneId so the instance survives window switches (same key
  // → React reuses it, no unmount/remount). Only the active window's panes are
  // visible; the rest are display:none + paused by TerminalPane. Switching
  // windows is then just pause/resume + reposition — no emulator teardown,
  // no pane-socket reconnect, no scrollback replay.

  // Zoom is rendered by overlaying the zoomed pane at full size on top of the
  // others rather than swapping the tree to a single pane. Keeping every pane
  // mounted makes zoom toggle instant: no Terminal teardown, no pane-socket
  // reconnect, no scrollback replay. The zoomed pane's container grows to fill
  // the grid, so its ResizeObserver resizes the PTY exactly as a
  // mounted-from-scratch zoomed pane would. Dividers are dropped while zoomed —
  // they'd sit under the overlay and resizing a hidden split makes no sense.

  return (
    <div
      ref={containerRef}
      style={{
        // Every pooled SessionPane overlays the same region (absolute inset:0);
        // only the active session's is shown. display:none on the whole root
        // hides an inactive session's panes and dividers at once, while its
        // TerminalPanes stay mounted + paused (see the per-pane visible flag).
        display: isActiveSession ? undefined : 'none',
        position: 'absolute',
        inset: 0,
      }}
    >
      {windows
        .filter((win) => mountedWindowIds.has(win.id) || win.id === activeWindow?.id)
        .flatMap((win) =>
          win.panes.map((pane) => {
            const rect = rectByPane.get(pane.id);
            // Visible only when this is the shown session AND the pane is in its
            // active window. A background session keeps all panes hidden +
            // paused (sockets still streaming), so switch-back is instant.
            const inActiveWindow = rect !== undefined;
            const isZoomed = isActiveSession && inActiveWindow && pane.id === zoomedPaneId;
            // When a pane is zoomed, hide all other active-window panes so their
            // borders don't show behind the zoomed overlay.
            const visible = isActiveSession && inActiveWindow && (!zoomedPaneId || isZoomed);
            return (
              <TerminalPane
                key={pane.id}
                sessionId={sessionId}
                paneId={pane.id}
                rect={isZoomed ? { ...HIDDEN, paneId: pane.id } : (rect ?? { ...HIDDEN, paneId: pane.id })}
                isActive={visible && (zoomedPaneId ? isZoomed : pane.id === activePaneId)}
                title={pane.title}
                cwd={pane.cwd}
                agentStatus={pane.agent_status}
                paneIndex={paneNumberById.get(pane.id) ?? 0}
                visible={visible}
                isZoomed={isZoomed}
                previewConfig={previewConfig}
                registry={registryRef.current}
                send={send}
              />
            );
          }),
        )}
      {!zoomedPaneId &&
        dividers.map((divider) => (
          <div
            key={divider.id}
            onMouseDown={(e) => handleDividerMouseDown(divider, e)}
            style={
              divider.orientation === 'vertical'
                ? {
                    position: 'absolute',
                    top: `${divider.crossStart}%`,
                    left: `${divider.position}%`,
                    transform: 'translateX(-50%)',
                    width: '8px',
                    height: `${divider.crossSize}%`,
                    cursor: 'col-resize',
                    zIndex: 10,
                  }
                : {
                    position: 'absolute',
                    top: `${divider.position}%`,
                    left: `${divider.crossStart}%`,
                    transform: 'translateY(-50%)',
                    width: `${divider.crossSize}%`,
                    height: '8px',
                    cursor: 'row-resize',
                    zIndex: 10,
                  }
            }
          />
        ))}
      {fileBrowserOpen && isActiveSession && fileBrowserPaneId && (
        <Dialog
          key="file-browser"
          isOpen
          onOpenChange={(open) => {
            if (!open) useStore.getState().setFileBrowserOpen(false);
          }}
          aria-label={fileBrowserMode === 'process' ? 'Processes' : fileBrowserMode === 'git' ? 'Git' : 'Files'}
          padding={0}
          // Fullscreen's 100dvh ignores the iOS keyboard; useVisualViewport tracks it.
          {...(narrow
            ? { variant: 'fullscreen', style: { height: 'var(--btm-viewport-height, 100dvh)' } }
            : { width: 'min(1440px, 94vw)', maxHeight: '90dvh', style: { height: '90dvh' } })}
        >
          {fileBrowserMode === 'process' ? (
            <ProcessOverlay
              sessionId={sessionId}
              paneId={fileBrowserPaneId}
              send={send}
              onClose={() => useStore.getState().setFileBrowserOpen(false)}
            />
          ) : (
            <FileBrowserOverlay
              cwd={fileBrowserCwd}
              sessionId={sessionId}
              paneId={fileBrowserPaneId}
              send={send}
              onClose={() => useStore.getState().setFileBrowserOpen(false)}
            />
          )}
        </Dialog>
      )}
      {showPaneNumbers &&
        rects.map((rect) => {
          const n = paneNumberById.get(rect.paneId);
          if (n === undefined) return null;
          const accent = config?.theme?.yellow ?? STARTUP_THEME.yellow;
          const bg = config?.theme?.background ?? STARTUP_THEME.background;
          return (
            <div
              key={`num-${rect.paneId}`}
              style={{
                position: 'absolute',
                top: `${rect.top}%`,
                left: `${rect.left}%`,
                width: `${rect.width}%`,
                height: `${rect.height}%`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                // Above the Neovim surface.
                zIndex: 35,
              }}
            >
              <span
                style={{
                  color: accent,
                  background: bg,
                  border: `2px solid ${accent}`,
                  borderRadius: '8px',
                  padding: '0.1em 0.4em',
                  fontFamily: 'var(--btmux-font)',
                  fontWeight: 'bold',
                  // Scale the digit with the pane, clamped so tiny panes stay legible.
                  fontSize: 'clamp(1.5rem, 8vmin, 6rem)',
                  lineHeight: 1,
                  opacity: 0.92,
                }}
              >
                {n}
              </span>
            </div>
          );
        })}
    </div>
  );
}
