import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { chromePalette, withAlpha } from '../lib/chrome-colors';
import { computeRectsAndDividers } from '../state/layout';
import { SessionState } from '../state/types';
import { MirrorPane } from './MirrorPane';

interface Props {
  send: (msg: ClientMessage) => void;
}

// Thumbnails use each split's stored ratio (no live drag), so a single shared
// empty override map suffices for every computeRectsAndDividers call.
const EMPTY_RATIOS: Map<string, number> = new Map();

/** A flat, keyboard-navigable row in the switcher tree. */
type Row =
  | { kind: 'session'; sessionId: string; expanded: boolean }
  | { kind: 'window'; sessionId: string; windowId: string; windowIndex: number };

/**
 * The session/window switcher (prefix + s). A centered modal with a session→window
 * tree on the left and a live pane-layout preview of the selected window on the
 * right. Selecting a window switches to it (across sessions); `x` kills the
 * selected session or window. Theme-driven via `chromePalette`.
 *
 * Like WindowGrid it's lazily mounted on first open and kept mounted (display
 * toggles) so the preview mirrors stay warm. It owns the keyboard while open —
 * the keybinding hook early-returns on `switcherOpen`.
 */
export function SessionSwitcher({ send }: Props) {
  const open = useStore((s) => s.switcherOpen);
  const setOpen = useStore((s) => s.setSwitcherOpen);
  const mountedOnce = useRef(false);
  if (open) mountedOnce.current = true;

  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const setOverlay = useStore((s) => s.setOverlay);
  const overlay = useStore((s) => s.overlay);
  const location = useLocation();
  const navigate = useNavigate();

  // Which sessions are collapsed in the tree. Default: everything expanded (the
  // design shows sessions expanded to their windows).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // The active session/window, derived from the URL (same approach as SessionPool).
  const activeSessionName = useMemo(() => {
    const m = location.pathname.match(/^\/s\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, [location.pathname]);
  const activeSession = activeSessionName ? allSessions.find((s) => s.name === activeSessionName) : null;
  const activeWindowId = activeSession?.windows[activeSession.active_window]?.id ?? null;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const sess of allSessions) {
      const expanded = !collapsed.has(sess.id);
      out.push({ kind: 'session', sessionId: sess.id, expanded });
      if (expanded) {
        sess.windows.forEach((win, windowIndex) =>
          out.push({ kind: 'window', sessionId: sess.id, windowId: win.id, windowIndex }),
        );
      }
    }
    return out;
  }, [allSessions, collapsed]);

  const sessionById = useMemo(() => new Map(allSessions.map((s) => [s.id, s])), [allSessions]);

  // On open: remember prior focus, focus the modal, and select the active window.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      const idx = activeWindowId ? rows.findIndex((r) => r.kind === 'window' && r.windowId === activeWindowId) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
      containerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, rows.length]);

  // A kill from the switcher opens a confirm overlay (which grabs focus); when it
  // closes, return keyboard focus to the switcher so navigation keeps working.
  useEffect(() => {
    if (open && !overlay) {
      const id = window.setTimeout(() => containerRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, overlay]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, rows.length - 1));
  const selected = rows[clampedIdx];

  // The window to preview: the selected window, or (on a session row) that
  // session's active window.
  const previewWindow = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'window') {
      const sess = sessionById.get(selected.sessionId);
      return sess?.windows[selected.windowIndex] ?? null;
    }
    const sess = sessionById.get(selected.sessionId);
    return sess?.windows[sess.active_window] ?? sess?.windows[0] ?? null;
  }, [selected, sessionById]);
  const previewSession = selected ? (sessionById.get(selected.sessionId) ?? null) : null;
  const previewWindowIndex =
    previewSession && previewWindow ? previewSession.windows.findIndex((w) => w.id === previewWindow.id) : -1;

  const cancel = () => {
    setOpen(false);
    const prev = prevFocusRef.current;
    if (prev && prev.isConnected) {
      window.setTimeout(() => {
        if (prev.isConnected) prev.focus();
      }, 0);
    }
  };

  const switchToWindow = (sess: SessionState, windowIndex: number) => {
    const win = sess.windows[windowIndex];
    if (!win) return;
    send({ type: 'switch_window', session_id: sess.id, index: windowIndex });
    navigate(`/s/${encodeURIComponent(sess.name)}/w/${encodeURIComponent(win.name)}`);
    setOpen(false);
  };

  const activate = (row: Row) => {
    const sess = sessionById.get(row.sessionId);
    if (!sess) return;
    if (row.kind === 'window') {
      switchToWindow(sess, row.windowIndex);
    } else {
      // Enter on a session row switches to its active window.
      switchToWindow(sess, sess.active_window);
    }
  };

  const killRow = (row: Row) => {
    const sess = sessionById.get(row.sessionId);
    if (!sess) return;
    if (row.kind === 'session') {
      setOverlay({
        mode: 'confirm',
        title: `kill session "${sess.name}"?`,
        onConfirm: () => send({ type: 'kill_session', id: sess.id }),
      });
    } else {
      const win = sess.windows[row.windowIndex];
      if (!win) return;
      setOverlay({
        mode: 'confirm',
        title: `kill window "${win.name}"?`,
        onConfirm: () => send({ type: 'kill_window', window_id: win.id }),
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const n = rows.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (n === 0) return;
    const down = e.key === 'ArrowDown' || e.key === 'j' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || e.key === 'k' || (e.ctrlKey && e.key === 'p');
    if (down || up) {
      e.preventDefault();
      setSelectedIdx((i) => (Math.min(i, n - 1) + (down ? 1 : -1) + n) % n);
      return;
    }
    // Collapse/expand a session with left/right.
    if ((e.key === 'ArrowRight' || e.key === 'l' || e.key === 'ArrowLeft' || e.key === 'h') && selected) {
      const collapse = e.key === 'ArrowLeft' || e.key === 'h';
      if (selected.kind === 'session') {
        e.preventDefault();
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (collapse) next.add(selected.sessionId);
          else next.delete(selected.sessionId);
          return next;
        });
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selected) activate(selected);
      return;
    }
    if (e.key === 'x') {
      e.preventDefault();
      if (selected) killRow(selected);
      return;
    }
  };

  if (!mountedOnce.current) return null;

  const c = chromePalette(config?.theme ?? null);
  const termFont = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));
  const font = Math.max(11, Math.min(15, Math.round(termFont * 0.72)));
  const animations = config?.animations ?? true;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: open ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        background: withAlpha(c.bodyBg, 0.55),
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        outline: 'none',
        zIndex: 30,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        fontSize: `${font}px`,
        animation: open && animations ? 'btm-fade .15s ease' : undefined,
      }}
    >
      <div
        style={{
          width: '760px',
          maxWidth: '94%',
          height: '440px',
          maxHeight: '88%',
          display: 'flex',
          borderRadius: '12px',
          overflow: 'hidden',
          background: c.panelBg,
          border: `1px solid ${c.border}`,
          boxShadow: `0 30px 80px ${withAlpha(c.bodyBg, 0.55)}`,
          animation: open && animations ? 'btm-in .18s ease' : undefined,
        }}
      >
        {/* Tree */}
        <div
          style={{
            width: '340px',
            flex: 'none',
            borderRight: `1px solid ${c.borderDim}`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '14px 16px 10px',
              color: c.fgDim,
              fontSize: '11px',
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              fontWeight: 700,
            }}
          >
            Sessions
          </div>
          <div style={{ overflow: 'auto', padding: '0 8px 12px' }}>
            {rows.map((row, i) => {
              const isSelected = i === clampedIdx;
              const sess = sessionById.get(row.sessionId);
              if (!sess) return null;
              if (row.kind === 'session') {
                return (
                  <div
                    key={`s-${row.sessionId}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedIdx(i);
                    }}
                    onDoubleClick={() => activate(row)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 10px 7px',
                      color: c.fgBright,
                      fontWeight: 700,
                      cursor: 'pointer',
                      borderRadius: '7px',
                      background: isSelected ? withAlpha(c.accent, 0.12) : 'transparent',
                    }}
                  >
                    <span style={{ color: row.expanded ? c.accent : c.fgDim }}>{row.expanded ? '▾' : '▸'}</span>
                    {sess.name}
                    <span style={{ color: c.fgDim, fontWeight: 500, fontSize: '11.5px' }}>
                      {sess.id === activeSession?.id ? 'attached · ' : ''}
                      {sess.windows.length} win
                    </span>
                  </div>
                );
              }
              const win = sess.windows[row.windowIndex];
              if (!win) return null;
              const isActiveWin = win.id === activeWindowId;
              const paneCount = win.panes.length;
              return (
                <div
                  key={`w-${row.windowId}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSelectedIdx(i);
                  }}
                  onDoubleClick={() => activate(row)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '9px',
                    padding: '6px 10px 6px 30px',
                    margin: '2px 0',
                    borderRadius: '7px',
                    cursor: 'pointer',
                    fontSize: '12.5px',
                    background: isSelected ? c.accent : 'transparent',
                    color: isSelected ? c.accentInk : c.fgMuted,
                    fontWeight: isSelected ? 700 : 400,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: '16px',
                      height: '16px',
                      padding: '0 4px',
                      borderRadius: '4px',
                      background: isSelected ? c.accentInk : withAlpha(c.fgMuted, 0.22),
                      color: isSelected ? c.accent : c.fgMuted,
                      fontSize: '11px',
                      fontWeight: 800,
                    }}
                  >
                    {row.windowIndex}
                  </span>
                  {win.name}
                  {isActiveWin && <span style={{ color: isSelected ? c.accentInk : c.accent }}>*</span>}
                  {win.zoomed_pane && <span style={{ color: isSelected ? c.accentInk : c.zoom }}>⛶</span>}
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      color: isSelected ? withAlpha(c.accentInk, 0.7) : c.fgDim,
                      fontSize: '11px',
                    }}
                  >
                    {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Preview */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 18px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '9px', marginBottom: '12px' }}>
            <span style={{ color: c.fgBright, fontWeight: 700 }}>
              {previewWindowIndex >= 0 ? `${previewWindowIndex}: ` : ''}
              {previewWindow?.name ?? '—'}
            </span>
            <span style={{ color: c.fgDim, fontSize: '12px' }}>preview</span>
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {previewWindow ? (
              <PreviewLayout
                window={previewWindow}
                open={open}
                c={c}
                activePaneId={previewWindow.panes[previewWindow.active_pane]?.id ?? null}
              />
            ) : (
              <div style={{ color: c.fgDim }}>No window.</div>
            )}
          </div>
          <div style={{ marginTop: '12px', display: 'flex', gap: '16px', color: c.fgDim, fontSize: '11.5px' }}>
            <span>
              <span style={{ color: c.fgMuted }}>↑↓</span> navigate
            </span>
            <span>
              <span style={{ color: c.fgMuted }}>↵</span> switch
            </span>
            <span>
              <span style={{ color: c.fgMuted }}>x</span> kill
            </span>
            <span>
              <span style={{ color: c.fgMuted }}>esc</span> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Live preview of a window's pane layout, one MirrorPane per leaf at its rect. */
function PreviewLayout({
  window: win,
  open,
  c,
  activePaneId,
}: {
  window: SessionState['windows'][number];
  open: boolean;
  c: ReturnType<typeof chromePalette>;
  activePaneId: string | null;
}) {
  const { rects, dividers } = computeRectsAndDividers(
    win.layout,
    { top: 0, left: 0, width: 100, height: 100 },
    EMPTY_RATIOS,
  );
  return (
    <>
      {rects.map((r) => {
        const isActive = r.paneId === activePaneId;
        return (
          <div
            key={r.paneId}
            style={{
              position: 'absolute',
              top: `${r.top}%`,
              left: `${r.left}%`,
              width: `${r.width}%`,
              height: `${r.height}%`,
              padding: '3px',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                borderRadius: '6px',
                border: `${isActive ? 1.5 : 1}px solid ${isActive ? c.accent : c.borderDim}`,
                boxShadow: isActive ? `0 0 18px ${c.accentGlow}` : undefined,
                background: withAlpha(c.bodyBg, 0.6),
              }}
            >
              {open && <MirrorPane paneId={r.paneId} visible={open} />}
            </div>
          </div>
        );
      })}
      {dividers.map((d) => (
        <div
          key={d.id}
          style={
            d.orientation === 'vertical'
              ? {
                  position: 'absolute',
                  top: `${d.crossStart}%`,
                  left: `${d.position}%`,
                  transform: 'translateX(-50%)',
                  width: '1px',
                  height: `${d.crossSize}%`,
                  background: 'transparent',
                  pointerEvents: 'none',
                }
              : {
                  position: 'absolute',
                  top: `${d.position}%`,
                  left: `${d.crossStart}%`,
                  transform: 'translateY(-50%)',
                  width: `${d.crossSize}%`,
                  height: '1px',
                  background: 'transparent',
                  pointerEvents: 'none',
                }
          }
        />
      ))}
    </>
  );
}
