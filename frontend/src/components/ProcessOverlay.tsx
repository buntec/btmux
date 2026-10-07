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
import { buildPortRows } from '@/lib/portRows';
import { buildProcessRows } from '@/lib/processTree';
import { KeyHint } from './KeyHint';
import { ProcessDetails } from './processes/ProcessDetails';
import { ProcessModeHeader } from './processes/ProcessModeHeader';
import { PortTable } from './processes/PortTable';
import { ProcessTree } from './processes/ProcessTree';
import type { ProcessSignal } from '@/protocol/process-messages';
import type { ClientMessage } from '@/protocol/messages';

const DEFAULT_TABLE_RATIO = 0.65;

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
  const viewMode = useProcessStore((s) => s.viewMode);
  const ports = useProcessStore((s) => s.snapshot?.ports);
  const portSortMode = useProcessStore((s) => s.portSortMode);
  const processes = useProcessStore((s) => s.processes);
  const collapsedPids = useProcessStore((s) => s.collapsedPids);
  const sortMode = useProcessStore((s) => s.sortMode);
  const treeMode = useProcessStore((s) => s.treeMode);
  const filterQuery = useProcessStore((s) => s.filterQuery);
  const filterActive = useProcessStore((s) => s.filterActive);
  const message = useProcessStore((s) => s.message);
  const [pendingKill, setPendingKill] = useState<PendingKill | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const { sidebarRatio: tableRatio, onDividerMouseDown } = useSidebarResize(bodyRef, DEFAULT_TABLE_RATIO, {
    axis: 'y',
    min: 0.25,
    max: 0.85,
  });

  const rows = useMemo(
    () => buildProcessRows(processes, collapsedPids, sortMode, treeMode, filterActive ? filterQuery : ''),
    [processes, collapsedPids, sortMode, treeMode, filterActive, filterQuery],
  );
  const portRows = useMemo(
    () => buildPortRows(ports ?? [], processes, portSortMode, filterActive ? filterQuery : ''),
    [ports, processes, portSortMode, filterActive, filterQuery],
  );
  const navigationRows =
    viewMode === 'ports'
      ? portRows.map((row) => ({ ...row, hasChildren: false }))
      : rows.map((row) => ({ ...row, key: String(row.process.pid) }));
  // The key handler reads rows through a ref so snapshots don't re-register it.
  const rowsRef = useRef(navigationRows);
  rowsRef.current = navigationRows;

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
      const focusedIndex = rows.findIndex(
        (row) => row.key === (store.viewMode === 'ports' ? store.focusedPort : String(store.focusedPid)),
      );
      const focusRow = (index: number) => {
        const row = rows[index];
        if (!row) return;
        if ('port' in row) store.setFocusedPort(row.key, row.port.pid);
        else store.setFocusedPid(row.process.pid);
      };
      const currentIndex = focusedIndex < 0 ? 0 : focusedIndex;
      const row = rows[currentIndex];
      const setExpanded = (expanded?: boolean) => {
        if (!row) return;
        if ('port' in row) {
          if (expanded === undefined || store.expandedPorts.has(row.key) !== expanded)
            store.togglePortExpanded(row.key);
        } else if (
          row.hasChildren &&
          (expanded === undefined || store.collapsedPids.has(row.process.pid) === expanded)
        ) {
          store.toggleCollapsed(row.process.pid);
        }
      };
      const move = (delta: number) => {
        if (count === 0) return;
        const next = Math.max(0, Math.min(currentIndex + delta, count - 1));
        focusRow(next);
      };

      if (store.filterActive) {
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
          focusRow(0);
          break;
        case 'G':
          e.preventDefault();
          focusRow(count - 1);
          break;
        case 'p':
          e.preventDefault();
          store.toggleViewMode();
          break;
        case 's':
          e.preventDefault();
          if (store.viewMode === 'ports') store.cyclePortSortMode();
          else store.cycleSortMode();
          break;
        case 'V':
          e.preventDefault();
          if (store.viewMode === 'processes') store.toggleTreeMode();
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
          setExpanded(false);
          break;
        case 'l':
        case 'ArrowRight':
          e.preventDefault();
          setExpanded(true);
          break;
        case 'Tab':
        case 'Enter':
        case ' ':
          e.preventDefault();
          setExpanded();
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          if (row?.process) {
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

      <VStack ref={bodyRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <VStack className="min-h-0 min-w-0 flex-none overflow-hidden" style={{ height: `${tableRatio * 100}%` }}>
          {viewMode === 'ports' ? <PortTable rows={portRows} /> : <ProcessTree rows={rows} />}
        </VStack>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize process list"
          onMouseDown={onDividerMouseDown}
          className="h-1 flex-none cursor-row-resize border-b border-border hover:bg-accent-bg active:bg-accent-bg"
        />
        <VStack className="min-h-0 min-w-0 flex-1">
          <ProcessDetails />
        </VStack>
      </VStack>

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
            {(viewMode === 'ports' || treeMode) && (
              <>
                <KeyHint keys={['h', 'l']} label="fold/unfold" />
                <KeyHint keys={['tab', 'enter']} label={viewMode === 'ports' ? 'connections' : 'toggle'} />
              </>
            )}
            <KeyHint keys={['x', 'X']} label="term/kill" />
            <KeyHint keys={['F']} label="follow" />
            <KeyHint keys={['s']} label="sort" />
            {viewMode === 'processes' && <KeyHint keys={['V']} label={treeMode ? 'flat' : 'tree'} />}
            <KeyHint keys={['p']} label={viewMode === 'ports' ? 'processes' : 'ports'} />
            <KeyHint keys={['/']} label="filter" />
            <KeyHint keys={['g', 'G']} label="top/bottom" />
            <KeyHint keys={['esc', 'q']} label="close" />
          </>
        )}
      </HStack>
    </VStack>
  );
}
