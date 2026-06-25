import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { getWindowMruOrder } from '../state/windowMru';
import { computeRectsAndDividers } from '../state/layout';
import { LayoutNode } from '../state/types';
import { MirrorPane } from './MirrorPane';

interface Props {
  send: (msg: ClientMessage) => void;
}

// Thumbnails use each split's stored ratio (no live drag), so a single shared
// empty override map suffices for every computeRectsAndDividers call.
const EMPTY_RATIOS: Map<string, number> = new Map();

interface GridEntry {
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowName: string;
  windowIndex: number;
  // Full split layout of the window — each leaf renders its own MirrorPane at its
  // rect, so the thumbnail mirrors the real pane arrangement.
  layout: LayoutNode;
}

/**
 * Build the N most-recently-viewed windows, most-recent first. Windows already
 * in the MRU order come first (in that order); any remaining windows fill the
 * rest in session/window order so a fresh browser (empty MRU) still shows a grid.
 */
function buildEntries(allSessions: ReturnType<typeof useStore.getState>['allSessions'], limit: number): GridEntry[] {
  const byWindowId = new Map<string, GridEntry>();
  for (const sess of allSessions) {
    sess.windows.forEach((win, windowIndex) => {
      byWindowId.set(win.id, {
        sessionId: sess.id,
        sessionName: sess.name,
        windowId: win.id,
        windowName: win.name,
        windowIndex,
        layout: win.layout,
      });
    });
  }

  const ordered: GridEntry[] = [];
  const seen = new Set<string>();
  for (const id of getWindowMruOrder()) {
    const entry = byWindowId.get(id);
    if (entry && !seen.has(id)) {
      ordered.push(entry);
      seen.add(id);
    }
  }
  // Fill remaining slots with not-yet-visited windows (creation order).
  for (const entry of byWindowId.values()) {
    if (!seen.has(entry.windowId)) {
      ordered.push(entry);
      seen.add(entry.windowId);
    }
  }
  return ordered.slice(0, Math.max(1, limit));
}

/**
 * Full-screen grid of live terminal thumbnails (prefix + w). Each cell renders
 * the full split layout of a recently-viewed window — one read-only MirrorPane
 * per pane, positioned at its layout rect — so the thumbnail mirrors the real
 * pane arrangement. Selecting one switches to that window (across sessions) and
 * closes the grid.
 *
 * Lazily mounted on first open, then kept mounted (display toggles) so the
 * thumbnail mirrors stay warm — reopening and switching are lag-free.
 */
export function WindowGrid({ send }: Props) {
  const open = useStore((s) => s.windowGridOpen);
  const setOpen = useStore((s) => s.setWindowGridOpen);
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const location = useLocation();
  const navigate = useNavigate();

  const limit = config?.window_grid_count ?? 6;
  // Recompute entries while open (MRU is stable then — we don't record visits
  // from inside the grid). Keep the last entries while closed so a re-open before
  // the next render still has content. Snapshot on the open transition.
  const entries = useMemo(() => buildEntries(allSessions, limit), [allSessions, limit, open]);

  // Defer MirrorPane mounting on first open so the grid structure (borders +
  // labels) paints before WASM terminal init blocks the main thread. Double-rAF
  // guarantees at least one paint cycle has flushed.
  const [mirrorsReady, setMirrorsReady] = useState(false);
  const hasEverBeenReady = useRef(false);
  useEffect(() => {
    if (open && !hasEverBeenReady.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMirrorsReady(true);
          hasEverBeenReady.current = true;
        });
      });
    }
  }, [open]);

  const cols = Math.ceil(Math.sqrt(entries.length));
  const rows = Math.ceil(entries.length / cols);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // The element focused before the grid grabbed focus (the active pane's
  // contenteditable). Restored on cancel — see cancel().
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // On each open, remember the prior focus, focus the grid, and pre-select
  // the currently active window.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      // Derive the active window from the URL + session state (same approach as
      // SessionPool). Pre-select it in the grid so the user sees their current
      // window highlighted.
      const match = location.pathname.match(/^\/s\/([^/]+)/);
      const activeSessionName = match ? decodeURIComponent(match[1]) : null;
      const activeSession = activeSessionName ? allSessions.find((s) => s.name === activeSessionName) : null;
      const activeWindowId = activeSession ? activeSession.windows[activeSession.active_window]?.id : undefined;
      const idx = activeWindowId ? entries.findIndex((e) => e.windowId === activeWindowId) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
      containerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, entries.length]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, entries.length - 1));

  // Cancel: close and return focus to the pane that had it. The grid div holds
  // focus while open; hiding it (display:none) drops focus to <body> as part of
  // the commit, so we restore on a macrotask (setTimeout 0) which lands after the
  // reset and wins. (On select() we navigate instead, which re-focuses the target
  // pane via SessionPane's focus effect.)
  const cancel = () => {
    setOpen(false);
    const prev = prevFocusRef.current;
    if (prev && prev.isConnected) {
      window.setTimeout(() => {
        if (prev.isConnected) prev.focus();
      }, 0);
    }
  };

  const select = (entry: GridEntry | undefined) => {
    if (!entry) return;
    send({ type: 'switch_window', session_id: entry.sessionId, index: entry.windowIndex });
    // Cross-session switches are driven by the URL (SessionPool derives the active
    // session from it); this mirrors LandingPage.navigateToNode's window branch.
    navigate(`/s/${encodeURIComponent(entry.sessionName)}/w/${encodeURIComponent(entry.windowName)}`);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const n = entries.length;
    if (n === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      select(entries[clampedIdx]);
      return;
    }
    // Arrow keys and vi-style h/j/k/l both move the highlight (mirrors LandingPage).
    const right = e.key === 'ArrowRight' || e.key === 'l';
    const left = e.key === 'ArrowLeft' || e.key === 'h';
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (right) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(n - 1, i + 1));
      return;
    }
    if (left) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (down) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(n - 1, i + cols));
      return;
    }
    if (up) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - cols));
      return;
    }
    // Digit keys jump the highlight to that 1-based cell.
    if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < n) {
        e.preventDefault();
        setSelectedIdx(idx);
      }
    }
  };

  // Only mount the heavy mirror tree once it's first been opened (sticky after).
  const mounted = useStore((s) => s.windowGridMounted);
  if (!mounted) return null;

  const theme = config?.theme;
  const bg = theme?.background ?? DEFAULT_THEME.background;
  const fg = theme?.foreground ?? DEFAULT_THEME.foreground;
  const dimFg = theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const ringColor = theme?.blue ?? DEFAULT_THEME.blue;
  const cellBorder = theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;
  const labelBg = theme?.background ?? DEFAULT_THEME.background;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        inset: 0,
        display: open ? 'grid' : 'none',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: '8px',
        padding: '8px',
        background: bg,
        outline: 'none',
        zIndex: 30,
        boxSizing: 'border-box',
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
      }}
    >
      {entries.length === 0 && <div style={{ color: dimFg, padding: '16px' }}>No windows.</div>}
      {entries.map((entry, i) => {
        const isSelected = i === clampedIdx;
        const { rects, dividers } = computeRectsAndDividers(
          entry.layout,
          { top: 0, left: 0, width: 100, height: 100 },
          EMPTY_RATIOS,
        );
        return (
          <div
            key={entry.windowId}
            onClick={() => select(entry)}
            style={{
              position: 'relative',
              overflow: 'hidden',
              cursor: 'pointer',
              border: `2px solid ${isSelected ? ringColor : cellBorder}`,
              boxShadow: isSelected ? `0 0 0 2px ${ringColor}` : undefined,
              boxSizing: 'border-box',
              background: bg,
            }}
          >
            {/* Live thumbnail of the full split layout. */}
            {rects.map((r) => (
              <div
                key={r.paneId}
                style={{
                  position: 'absolute',
                  top: `${r.top}%`,
                  left: `${r.left}%`,
                  width: `${r.width}%`,
                  height: `${r.height}%`,
                  padding: '2px',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
                  {mirrorsReady && <MirrorPane paneId={r.paneId} visible={open} />}
                </div>
              </div>
            ))}
            {/* Pane dividers */}
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
                        background: cellBorder,
                        pointerEvents: 'none',
                        zIndex: 1,
                      }
                    : {
                        position: 'absolute',
                        top: `${d.position}%`,
                        left: `${d.crossStart}%`,
                        transform: 'translateY(-50%)',
                        width: `${d.crossSize}%`,
                        height: '1px',
                        background: cellBorder,
                        pointerEvents: 'none',
                        zIndex: 1,
                      }
                }
              />
            ))}
            {/* Label over the bottom edge. */}
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                padding: '2px 6px',
                fontSize: '11px',
                color: fg,
                background: `${labelBg}cc`,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                pointerEvents: 'none',
              }}
            >
              <span style={{ opacity: 0.5 }}>{i + 1}. </span>
              {entry.sessionName} <span style={{ opacity: 0.5 }}>›</span> {entry.windowName}
            </div>
          </div>
        );
      })}
    </div>
  );
}
