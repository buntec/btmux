import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { useProcessSocket } from '@/hooks/useProcessSocket';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import { useProcessStore } from '@/state/processStore';
import { useStore } from '@/state/store';
import { getAnimations, getTerminalFontSize } from '@/state/configDefaults';
import { buildProcessRows } from '@/lib/processTree';
import { KeyHint } from './KeyHint';
import { ProcessDetails } from './processes/ProcessDetails';
import { ProcessModeHeader } from './processes/ProcessModeHeader';
import { ProcessTree } from './processes/ProcessTree';
import type { ProcessSignal } from '@/protocol/process-messages';
import type { ClientMessage } from '@/protocol/messages';

const DEFAULT_SIDEBAR_RATIO = 0.5;

interface PendingKill {
  pid: number;
  startTime: number;
  name: string;
  signal: ProcessSignal;
}

interface ProcessOverlayProps {
  sessionId: string;
  paneId: string;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function ProcessOverlay({ sessionId, paneId, send, onClose }: ProcessOverlayProps) {
  const { sendKill, state: connectionState } = useProcessSocket(true);
  const config = useStore((s) => s.config);
  const fontSize = getTerminalFontSize(config);
  const animations = getAnimations(config);
  const processes = useProcessStore((s) => s.processes);
  const collapsedPids = useProcessStore((s) => s.collapsedPids);
  const sortMode = useProcessStore((s) => s.sortMode);
  const treeMode = useProcessStore((s) => s.treeMode);
  const filterQuery = useProcessStore((s) => s.filterQuery);
  const filterActive = useProcessStore((s) => s.filterActive);
  const message = useProcessStore((s) => s.message);
  const [pendingKill, setPendingKill] = useState<PendingKill | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { sidebarRatio, onDividerMouseDown } = useSidebarResize(rootRef, DEFAULT_SIDEBAR_RATIO);

  const rows = useMemo(
    () => buildProcessRows(processes, collapsedPids, sortMode, treeMode, filterActive ? filterQuery : ''),
    [processes, collapsedPids, sortMode, treeMode, filterActive, filterQuery],
  );
  // The key handler reads rows through a ref so snapshots don't re-register it.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Start the next open from a clean slate.
  useEffect(() => () => useProcessStore.getState().reset(), []);

  // Track whether this pane is the active one, and focus accordingly.
  const isActive = useStore((s) => {
    const session = s.allSessions.find((item) => item.id === sessionId);
    const win = session?.windows[session.active_window];
    return win?.panes[win.active_pane]?.id === paneId;
  });
  const mountedRef = useRef(false);
  useEffect(() => {
    // Focus on mount, and again whenever the pane becomes active.
    if (mountedRef.current && !isActive) return;
    mountedRef.current = true;
    const id = window.setTimeout(() => rootRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isActive]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      // Let the global keybinding handler consume prefix sequences.
      if (useStore.getState().prefixActive) return;

      const store = useProcessStore.getState();
      const rows = rowsRef.current;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (store.filterActive) store.setFilterActive(false);
        else if (pendingKill) setPendingKill(null);
        else onClose();
        return;
      }

      if (pendingKill) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'y' || e.key === 'Y') {
          sendKill(pendingKill.pid, pendingKill.startTime, pendingKill.signal);
          setPendingKill(null);
        } else if (e.key === 'n' || e.key === 'N') {
          setPendingKill(null);
        }
        return;
      }

      // Same tree navigation language as git mode: j/k move between rows,
      // while h/l fold and unfold the focused tree.
      const count = rows.length;
      const focusedIndex = rows.findIndex((row) => row.process.pid === store.focusedPid);
      const currentIndex = focusedIndex < 0 ? 0 : focusedIndex;
      const row = rows[currentIndex];
      const move = (delta: number) => {
        if (count === 0) return;
        const next = Math.max(0, Math.min(currentIndex + delta, count - 1));
        store.setFocusedPid(rows[next].process.pid);
      };

      if (store.filterActive) {
        if (e.key === 'F5') {
          e.preventDefault();
          store.toggleTreeMode();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          store.setFilterActive(false);
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          store.setFilterQuery(store.filterQuery.slice(0, -1));
          return;
        }
        if ((e.ctrlKey && e.key === 'n') || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
          return;
        }
        if ((e.ctrlKey && e.key === 'p') || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          store.setFilterQuery(store.filterQuery + e.key);
          return;
        }
        if (!e.ctrlKey) return;
      }

      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        move(Math.max(1, Math.floor(count / 2)));
        return;
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        move(-Math.max(1, Math.floor(count / 2)));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          break;
        case 'g':
          e.preventDefault();
          if (rows[0]) store.setFocusedPid(rows[0].process.pid);
          break;
        case 'G':
          e.preventDefault();
          if (rows[count - 1]) store.setFocusedPid(rows[count - 1].process.pid);
          break;
        case 's':
          e.preventDefault();
          store.cycleSortMode();
          break;
        case 'F5':
        case 'V':
          e.preventDefault();
          store.toggleTreeMode();
          break;
        case 'F':
          e.preventDefault();
          store.toggleFollowFocus();
          break;
        case '/':
          e.preventDefault();
          store.setFilterActive(true);
          break;
        case 'h':
        case 'ArrowLeft':
          e.preventDefault();
          if (row?.hasChildren && !store.collapsedPids.has(row.process.pid)) store.toggleCollapsed(row.process.pid);
          break;
        case 'l':
        case 'ArrowRight':
          e.preventDefault();
          if (row?.hasChildren && store.collapsedPids.has(row.process.pid)) store.toggleCollapsed(row.process.pid);
          break;
        case 'Tab':
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (row?.hasChildren) store.toggleCollapsed(row.process.pid);
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          if (row) {
            setPendingKill({
              pid: row.process.pid,
              startTime: row.process.start_time,
              name: row.process.name || row.process.command,
              signal: e.key === 'X' ? 'kill' : 'term',
            });
          }
          break;
        case 'q':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose, pendingKill, sendKill]);

  return (
    <VStack
      ref={rootRef}
      tabIndex={-1}
      className="h-full min-h-0 overflow-hidden outline-none"
      style={{ fontSize: `${fontSize}px` }}
      onMouseDown={() => {
        if (!isActive) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
        rootRef.current?.focus();
      }}
    >
      <HStack gap={3} vAlign="center" className="min-w-0 flex-none border-b border-border px-3 py-1.5">
        <ProcessModeHeader connectionState={connectionState} animations={animations} />
        <IconButton label="Close process viewer" icon={<X />} variant="ghost" size="sm" onClick={onClose} />
      </HStack>

      <HStack className="min-h-0 min-w-0 flex-1 items-stretch overflow-hidden">
        <VStack className="min-h-0 min-w-0 flex-none overflow-hidden" style={{ width: `${sidebarRatio * 100}%` }}>
          <ProcessTree rows={rows} />
        </VStack>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize process list"
          onMouseDown={onDividerMouseDown}
          className="w-1 flex-none cursor-col-resize border-r border-border hover:bg-accent-bg active:bg-accent-bg"
        />
        <VStack className="min-h-0 min-w-0 flex-1">
          <ProcessDetails />
        </VStack>
      </HStack>

      <HStack gap={4} vAlign="center" className="flex-none overflow-hidden border-t border-border px-3 py-1">
        {pendingKill ? (
          <>
            <Text size="sm">
              {pendingKill.signal === 'kill' ? 'Kill (SIGKILL) ' : 'Terminate '}
              <Text size="sm" color="inherit" className="text-yellow-vivid">
                {pendingKill.name}
              </Text>{' '}
              <Text size="sm" color="secondary">
                (PID {pendingKill.pid})
              </Text>
              ?
            </Text>
            <KeyHint keys={['y']} label="confirm" />
            <KeyHint keys={['n']} label="cancel" />
          </>
        ) : (
          <>
            {message && (
              <Text
                size="sm"
                color="inherit"
                textWrap="nowrap"
                className={message.type === 'error' || !message.success ? 'text-error' : 'text-success'}
              >
                {message.message}
              </Text>
            )}
            <KeyHint keys={['j', 'k']} label="navigate" />
            {treeMode && (
              <>
                <KeyHint keys={['h', 'l']} label="fold/unfold" />
                <KeyHint keys={['tab', 'enter']} label="toggle" />
              </>
            )}
            <KeyHint keys={['x', 'shift+x']} label="term/kill" />
            <KeyHint keys={['shift+f']} label="follow" />
            <KeyHint keys={['s']} label="sort" />
            <KeyHint keys={['f5', 'shift+v']} label={treeMode ? 'flat' : 'tree'} />
            <KeyHint keys={['/']} label="filter" />
            <KeyHint keys={['g', 'shift+g']} label="top/bottom" />
            <KeyHint keys={['esc', 'q']} label="close" />
          </>
        )}
      </HStack>
    </VStack>
  );
}
