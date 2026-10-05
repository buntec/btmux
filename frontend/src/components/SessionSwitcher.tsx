import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter, LayoutPanel, HStack, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Text } from '@astryxdesign/core/Text';
import { Badge } from '@astryxdesign/core/Badge';
import { Token } from '@astryxdesign/core/Token';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { Icon } from '@astryxdesign/core/Icon';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { ChevronDown, ChevronRight, Maximize2 } from 'lucide-react';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { chromePalette } from '../lib/chrome-colors';
import { SessionState } from '../state/types';
import { WindowThumbnail } from './WindowThumbnail';
import { SessionIcon } from './SessionIcon';
import { sortSessions } from '../state/sessionMru';
import { sortWindows } from '../state/windowMru';
import { getAnimations, getSessionSort, getWindowSort } from '../state/configDefaults';
import { KeyCap, KeyHint } from './KeyHint';

interface Props {
  send: (msg: ClientMessage) => void;
}

/** A flat, keyboard-navigable row in the switcher tree. `windowIndex` is the
 *  backend index (for switch_window / preview lookup); `displayIndex` is its
 *  position in the sorted display order (the number badge). */
type Row =
  | { kind: 'session'; sessionId: string; expanded: boolean }
  | { kind: 'window'; sessionId: string; windowId: string; windowIndex: number; displayIndex: number };

/**
 * The session/window switcher (prefix + s). A centered modal with a session→window
 * tree on the left and a live pane-layout preview of the selected window on the
 * right. Selecting a window switches to it (across sessions); `m` renames the
 * selected session or window and `x` kills the selected session or window.
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

  // Which sessions are expanded in the tree. Default: everything collapsed —
  // sessions fold up to a single row each, expand (→ / l) to reveal windows.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  // Incremental filter (tmux-style): `/` enters filter mode; typing narrows the
  // tree to sessions whose name (or a window's name) matches.
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [hoveredPaneId, setHoveredPaneId] = useState<string | null>(null);
  // Inline kill confirmation shown in the footer (like the file browser).
  const [pendingKill, setPendingKill] = useState<{
    kind: 'session' | 'window';
    name: string;
    msg: ClientMessage;
  } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);
  const isNarrow = useMediaQuery('(max-width: 767px)');

  // Track viewport aspect ratio so the preview box matches the real terminal window.
  const viewportAspect = useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    () => window.innerWidth / window.innerHeight,
  );

  // The active session/window, derived from the URL (same approach as SessionPool).
  const activeSessionName = useMemo(() => {
    const m = location.pathname.match(/^\/s\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, [location.pathname]);
  const activeSession = activeSessionName ? allSessions.find((s) => s.name === activeSessionName) : null;
  const activeWindowId = activeSession?.windows[activeSession.active_window]?.id ?? null;

  const query = filterQuery.trim().toLowerCase();
  const sortedSessions = useMemo(
    () => sortSessions(allSessions, getSessionSort(config)),
    [allSessions, config?.session_sort],
  );
  const windowSort = getWindowSort(config);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const sess of sortedSessions) {
      // Windows in display order (`window_sort`); each carries its backend index
      // (for switch_window/preview) while its sorted position is the number badge.
      const ordered = sortWindows(sess.windows, windowSort).map(({ win, index }, displayIndex) => ({
        win,
        windowIndex: index,
        displayIndex,
      }));
      // A session shows if it matches by name, or if any of its windows match.
      // While filtering, matching sessions auto-expand so the matches are visible.
      const sessMatch = !query || sess.name.toLowerCase().includes(query);
      const matchingWindows = query
        ? ordered.filter(({ win }) => sessMatch || win.name.toLowerCase().includes(query))
        : ordered;
      if (query && !sessMatch && matchingWindows.length === 0) continue;

      const isExpanded = query ? true : expanded.has(sess.id);
      out.push({ kind: 'session', sessionId: sess.id, expanded: isExpanded });
      if (isExpanded) {
        for (const { win, windowIndex, displayIndex } of matchingWindows) {
          out.push({ kind: 'window', sessionId: sess.id, windowId: win.id, windowIndex, displayIndex });
        }
      }
    }
    return out;
  }, [sortedSessions, expanded, query, windowSort]);

  const sessionById = useMemo(() => new Map(allSessions.map((s) => [s.id, s])), [allSessions]);

  // On open: reset the filter and select the active session's row (the tree
  // starts collapsed, so windows aren't shown).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFilterMode(false);
      setFilterQuery('');
      setHoveredPaneId(null);
      setExpanded(new Set());
      const idx = activeSession ? rows.findIndex((r) => r.kind === 'session' && r.sessionId === activeSession.id) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
    }
    wasOpen.current = open;
  }, [open, rows.length]);

  // Keep the selected row scrolled into view as the cursor moves.
  useEffect(() => {
    if (open) selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, open, rows.length]);

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

  // Debounce the preview so rapid cycling doesn't mount/unmount MirrorPanes
  // on every keypress (each mount opens a WebSocket + Terminal init).
  const [debouncedPreviewWindow, setDebouncedPreviewWindow] = useState(previewWindow);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      setDebouncedPreviewWindow(previewWindow);
    }, 120);
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  }, [previewWindow]);

  // The preview is debounced independently from the tree cursor. Resolve its
  // owning session from the window itself so a click during that short delay
  // always targets the pane currently visible on screen.
  const debouncedPreviewContext = useMemo(() => {
    if (!debouncedPreviewWindow) return null;
    for (const sess of allSessions) {
      const windowIndex = sess.windows.findIndex((win) => win.id === debouncedPreviewWindow.id);
      if (windowIndex >= 0) return { sess, windowIndex };
    }
    return null;
  }, [allSessions, debouncedPreviewWindow]);
  // Number shown in the preview header — the *display* position (matches the tree
  // badge), not the backend index, so it stays consistent under a window sort.
  const previewWindowIndex =
    debouncedPreviewContext && debouncedPreviewWindow
      ? sortWindows(debouncedPreviewContext.sess.windows, windowSort).findIndex(
          (o) => o.win.id === debouncedPreviewWindow.id,
        )
      : -1;

  const cancel = () => setOpen(false);

  useEffect(() => {
    if (!open) setPendingKill(null);
  }, [open]);

  const exitFilter = () => {
    setFilterMode(false);
    setFilterQuery('');
    setSelectedIdx(0);
    // The filter input unmounts; keep keyboard focus inside the dialog.
    dialogRef.current?.focus();
  };

  const switchToWindow = (sess: SessionState, windowIndex: number) => {
    const win = sess.windows[windowIndex];
    if (!win) return;
    send({ type: 'switch_window', session_id: sess.id, index: windowIndex });
    navigate(`/s/${encodeURIComponent(sess.name)}/w/${encodeURIComponent(win.name)}`);
    setOpen(false);
  };

  const switchToPane = (sess: SessionState, windowIndex: number, paneId: string) => {
    const win = sess.windows[windowIndex];
    if (!win || !win.panes.some((pane) => pane.id === paneId)) return;
    // select_pane operates on the session's active window, so preserve this
    // ordering on the control socket when the preview belongs to another window.
    send({ type: 'switch_window', session_id: sess.id, index: windowIndex });
    send({ type: 'select_pane', session_id: sess.id, pane_id: paneId });
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
      setPendingKill({ kind: 'session', name: sess.name, msg: { type: 'kill_session', id: sess.id } });
    } else {
      const win = sess.windows[row.windowIndex];
      if (!win) return;
      setPendingKill({ kind: 'window', name: win.name, msg: { type: 'kill_window', window_id: win.id } });
    }
  };

  const renameRow = (row: Row) => {
    const sess = sessionById.get(row.sessionId);
    if (!sess) return;
    if (row.kind === 'window') {
      const win = sess.windows[row.windowIndex];
      if (!win) return;
      // rename_window operates on the session's active window, so select the
      // highlighted window before opening the prompt.
      send({ type: 'switch_window', session_id: sess.id, index: row.windowIndex });
      setOverlay({
        mode: 'prompt',
        title: 'rename-window',
        value: win.name,
        action: 'rename-window',
        targetSessionId: sess.id,
      });
      return;
    }
    setOverlay({
      mode: 'prompt',
      title: 'rename-session',
      value: sess.name,
      action: 'rename-session',
      targetSessionId: sess.id,
    });
  };

  const setSessionExpanded = (sessionId: string, want: boolean) => {
    setExpanded((prev) => {
      if (prev.has(sessionId) === want) return prev;
      const next = new Set(prev);
      if (want) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const n = rows.length;

    if (pendingKill) {
      e.preventDefault();
      if (e.key === 'y' || e.key === 'Y') {
        send(pendingKill.msg);
        setPendingKill(null);
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        setPendingKill(null);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      // Escape first exits filter mode, then closes the modal.
      if (filterMode) exitFilter();
      else cancel();
      return;
    }

    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (!filterMode && e.key === 'j');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (!filterMode && e.key === 'k');
    if (down || up) {
      e.preventDefault();
      if (n === 0) return;
      setSelectedIdx((i) => (Math.min(i, n - 1) + (down ? 1 : -1) + n) % n);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (selected) activate(selected);
      return;
    }

    // Filter mode: the input owns text editing; arrows (handled above) move the
    // cursor. j/k/h/l/x are reserved for typing while filtering.
    if (filterMode) return;

    if (e.key === '/') {
      e.preventDefault();
      setFilterMode(true);
      setFilterQuery('');
      setSelectedIdx(0);
      return;
    }

    if (e.key === 'c') {
      e.preventDefault();
      if (selected?.kind === 'window') {
        send({ type: 'create_window', session_id: selected.sessionId });
        return;
      }
      setOverlay({
        mode: 'prompt',
        title: 'new-session',
        value: '',
        action: 'new-session',
      });
      return;
    }

    if (e.key === 'n') {
      e.preventDefault();
      setOverlay({
        mode: 'prompt',
        title: 'new-session',
        value: '',
        action: 'new-session',
      });
      return;
    }

    if (e.key === 'm') {
      e.preventDefault();
      if (selected) renameRow(selected);
      return;
    }

    if (n === 0) return;

    // Collapse/expand a session with left/right (or vi h/l). On a window row,
    // left collapses back to its parent session.
    if (selected && (e.key === 'ArrowRight' || e.key === 'l')) {
      e.preventDefault();
      if (selected.kind === 'session') {
        if (selected.expanded) {
          // Already open: move onto its first window.
          const firstWin = rows.findIndex(
            (r, i) => i > clampedIdx && r.kind === 'window' && r.sessionId === selected.sessionId,
          );
          if (firstWin >= 0) setSelectedIdx(firstWin);
        } else {
          setSessionExpanded(selected.sessionId, true);
        }
      }
      return;
    }
    if (selected && (e.key === 'ArrowLeft' || e.key === 'h')) {
      e.preventDefault();
      if (selected.kind === 'window') {
        const parentIdx = rows.findIndex((r) => r.kind === 'session' && r.sessionId === selected.sessionId);
        setSessionExpanded(selected.sessionId, false);
        if (parentIdx >= 0) setSelectedIdx(parentIdx);
      } else if (selected.kind === 'session') {
        setSessionExpanded(selected.sessionId, false);
      }
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
  const animations = getAnimations(config);

  const tree = (
    <VStack gap={2}>
      {filterMode && (
        <TextInput
          label="Filter sessions"
          isLabelHidden
          placeholder="Filter sessions and windows"
          size="sm"
          value={filterQuery}
          hasAutoFocus
          onChange={(value) => {
            setFilterQuery(value);
            setSelectedIdx(0);
          }}
        />
      )}
      {rows.length === 0 ? (
        <Text color="secondary">{query ? `No sessions matching "${filterQuery.trim()}".` : 'No sessions.'}</Text>
      ) : (
        <List density="compact">
          {rows.map((row, i) => {
            const isSelected = i === clampedIdx;
            const sess = sessionById.get(row.sessionId);
            if (!sess) return null;
            if (row.kind === 'session') {
              return (
                <ListItem
                  key={`s-${row.sessionId}`}
                  ref={isSelected ? selectedRef : null}
                  label={sess.name}
                  isSelected={isSelected}
                  startContent={
                    <HStack gap={2} vAlign="center">
                      <Icon icon={row.expanded ? ChevronDown : ChevronRight} size="sm" color="secondary" />
                      <SessionIcon session={sess} />
                    </HStack>
                  }
                  endContent={
                    <HStack gap={1} vAlign="center">
                      {sess.id === activeSession?.id && <Token label="attached" size="sm" color="blue" />}
                      <Badge variant="neutral" label={sess.windows.length} />
                    </HStack>
                  }
                  onClick={() => {
                    setSelectedIdx(i);
                    setSessionExpanded(row.sessionId, !row.expanded);
                  }}
                  onDoubleClick={() => activate(row)}
                />
              );
            }
            const win = sess.windows[row.windowIndex];
            if (!win) return null;
            const paneCount = win.panes.length;
            return (
              <ListItem
                key={`w-${row.windowId}`}
                ref={isSelected ? selectedRef : null}
                label={win.name}
                isSelected={isSelected}
                className="pl-8"
                startContent={
                  <Token
                    label={String(row.displayIndex)}
                    size="sm"
                    color={win.id === activeWindowId ? 'blue' : 'gray'}
                  />
                }
                endContent={
                  <HStack gap={2} vAlign="center">
                    {win.zoomed_pane && <Icon icon={Maximize2} size="sm" color="secondary" label="Zoomed" />}
                    <Text color="secondary">
                      {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                    </Text>
                  </HStack>
                }
                onClick={() => setSelectedIdx(i)}
                onDoubleClick={() => activate(row)}
              />
            );
          })}
        </List>
      )}
    </VStack>
  );

  const preview = (
    <VStack ref={previewRef} gap={3}>
      <HStack gap={2} vAlign="center">
        <Text>
          {previewWindowIndex >= 0 ? `${previewWindowIndex}: ` : ''}
          {debouncedPreviewWindow?.name ?? '—'}
        </Text>
        <Text color="secondary">preview</Text>
      </HStack>
      {debouncedPreviewWindow ? (
        <AspectRatio ratio={viewportAspect}>
          <WindowThumbnail
            window={debouncedPreviewWindow}
            visible={open}
            c={c}
            activePaneId={debouncedPreviewWindow.panes[debouncedPreviewWindow.active_pane]?.id ?? null}
            hoveredPaneId={hoveredPaneId}
            onHoveredPaneChange={setHoveredPaneId}
            onSelectPane={(paneId) => {
              if (debouncedPreviewContext) {
                switchToPane(debouncedPreviewContext.sess, debouncedPreviewContext.windowIndex, paneId);
              }
            }}
            animations={animations}
          />
        </AspectRatio>
      ) : (
        <Text color="secondary">No window.</Text>
      )}
    </VStack>
  );

  return (
    <Dialog
      ref={dialogRef}
      tabIndex={-1}
      isOpen={open && !overlay}
      onOpenChange={(value) => {
        if (!value) cancel();
      }}
      width={960}
      maxHeight="85dvh"
      style={{ height: 'min(560px, 85dvh)' }}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        // MirrorPane's Terminal.open() focuses its textarea; keep keys on the dialog.
        if (previewRef.current?.contains(e.target as Node)) dialogRef.current?.focus();
      }}
    >
      <Layout
        header={
          <DialogHeader
            title="Sessions"
            onOpenChange={(value) => {
              if (!value) cancel();
            }}
          />
        }
        start={
          isNarrow ? undefined : (
            <LayoutPanel width={340} hasDivider padding={2}>
              {tree}
            </LayoutPanel>
          )
        }
        content={<LayoutContent padding={isNarrow ? 2 : 4}>{isNarrow ? tree : preview}</LayoutContent>}
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={4} wrap="wrap">
              {pendingKill ? (
                <>
                  <Text size="sm">
                    Kill {pendingKill.kind}{' '}
                    <Text size="sm" color="inherit" className="text-yellow-vivid">
                      {pendingKill.name}
                    </Text>
                    ?
                  </Text>
                  <KeyHint keys={['y']} label="confirm" />
                  <KeyHint keys={['n']} label="cancel" />
                </>
              ) : (
                HINTS.map(([keys, label]) => (
                  <HStack key={label} gap={1} vAlign="center">
                    {keys.map((key) => (
                      <KeyCap key={key} keys={key} />
                    ))}
                    <Text color="secondary">{label}</Text>
                  </HStack>
                ))
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

const HINTS: [string[], string][] = [
  [['up', 'down'], 'navigate'],
  [['left', 'right'], 'fold'],
  [['/'], 'filter'],
  [['enter'], 'switch'],
  [['c'], 'new'],
  [['m'], 'rename'],
  [['x'], 'kill'],
  [['esc'], 'close'],
];
