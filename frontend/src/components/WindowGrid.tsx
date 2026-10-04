import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from '@astryxdesign/core/Layout';
import { Grid } from '@astryxdesign/core/Grid';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import { Text } from '@astryxdesign/core/Text';
import { Kbd } from '@astryxdesign/core/Kbd';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { chromePalette } from '../lib/chrome-colors';
import { getWindowMruOrder } from '../state/windowMru';
import type { SessionState } from '../state/types';
import { WindowThumbnail } from './WindowThumbnail';
import { getAnimations, getWindowGridCount } from '../state/configDefaults';
import { KeyCap } from './KeyHint';

interface Props {
  send: (msg: ClientMessage) => void;
}

interface GridEntry {
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowName: string;
  windowIndex: number;
  window: SessionState['windows'][number];
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
        window: win,
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

  const limit = getWindowGridCount(config);
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
  const dialogRef = useRef<HTMLDialogElement>(null);

  // On each open, pre-select the currently active window.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Derive the active window from the URL + session state (same approach as
      // SessionPool). Pre-select it in the grid so the user sees their current
      // window highlighted.
      const match = location.pathname.match(/^\/s\/([^/]+)/);
      const activeSessionName = match ? decodeURIComponent(match[1]) : null;
      const activeSession = activeSessionName ? allSessions.find((s) => s.name === activeSessionName) : null;
      const activeWindowId = activeSession ? activeSession.windows[activeSession.active_window]?.id : undefined;
      const idx = activeWindowId ? entries.findIndex((e) => e.windowId === activeWindowId) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
    }
    wasOpen.current = open;
  }, [open, entries.length]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, entries.length - 1));

  // The native dialog restores focus to the pane on close.
  const cancel = () => setOpen(false);

  const select = (entry: GridEntry | undefined) => {
    if (!entry) return;
    send({ type: 'switch_window', session_id: entry.sessionId, index: entry.windowIndex });
    // Cross-session switches are driven by the URL (SessionPool derives the active
    // session from it).
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
    // Arrow keys and vi-style h/j/k/l both move the highlight.
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

  const c = chromePalette(config?.theme ?? null);
  const animations = getAnimations(config);

  return (
    <Dialog
      ref={dialogRef}
      tabIndex={-1}
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) cancel();
      }}
      variant="fullscreen"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        // MirrorPane's Terminal.open() focuses its textarea; keep keys on the dialog.
        if ((e.target as Element).closest('[data-window-thumbnail]')) dialogRef.current?.focus();
      }}
    >
      <Layout
        header={
          <DialogHeader
            title="Windows"
            onOpenChange={(value) => {
              if (!value) cancel();
            }}
          />
        }
        content={
          <LayoutContent isScrollable={false} padding={4}>
            {entries.length === 0 ? (
              <Text color="secondary">No windows.</Text>
            ) : (
              <Grid
                columns={cols}
                gap={3}
                height="100%"
                style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
              >
                {entries.map((entry, i) => (
                  <SelectableCard
                    key={entry.windowId}
                    label={`${entry.sessionName} › ${entry.windowName}`}
                    isSelected={i === clampedIdx}
                    onChange={() => select(entry)}
                    padding={2}
                    height="100%"
                  >
                    <VStack gap={2} className="h-full min-h-0">
                      <HStack gap={2} vAlign="center" className="min-w-0">
                        {i < 9 && <Kbd keys={String(i + 1)} />}
                        <Text color="secondary">{entry.sessionName}</Text>
                        <Text>{entry.windowName}</Text>
                      </HStack>
                      <VStack data-window-thumbnail className="relative min-h-0 flex-1 overflow-hidden">
                        <WindowThumbnail
                          window={entry.window}
                          visible={open}
                          isMounted={mirrorsReady}
                          c={c}
                          activePaneId={entry.window.panes[entry.window.active_pane]?.id ?? null}
                          animations={animations}
                        />
                      </VStack>
                    </VStack>
                  </SelectableCard>
                ))}
              </Grid>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={4} wrap="wrap">
              {HINTS.map(([keys, label]) => (
                <HStack key={label} gap={1} vAlign="center">
                  {keys.map((key) => (
                    <KeyCap key={key} keys={key} />
                  ))}
                  <Text color="secondary">{label}</Text>
                </HStack>
              ))}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

const HINTS: [string[], string][] = [
  [['up', 'down', 'left', 'right'], 'move'],
  [['1', '9'], 'jump to cell'],
  [['enter'], 'switch'],
  [['esc'], 'close'],
];
