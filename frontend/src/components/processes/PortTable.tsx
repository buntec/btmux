import { Fragment, useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from '@astryxdesign/core/Table';
import { useProcessStore } from '@/state/processStore';
import {
  isPortSortDescending,
  PORT_SORT_LABELS,
  resolveFocusedPort,
  type PortRow,
  type PortSortMode,
} from '@/lib/portRows';
import { cn } from '@/lib/utils';
import { Placeholder } from '../files/Placeholder';

const COLUMNS: Array<{ label: string; mode: PortSortMode }> = [
  { label: 'PORT', mode: 'port' },
  { label: 'PROTOCOL', mode: 'protocol' },
  { label: 'ADDRESS', mode: 'address' },
  { label: 'STATE', mode: 'state' },
  { label: 'PID', mode: 'pid' },
  { label: 'PROCESS', mode: 'command' },
  { label: 'CONNECTIONS', mode: 'connections' },
];

export function PortTable({ rows }: { rows: PortRow[] }) {
  const snapshot = useProcessStore((s) => s.snapshot);
  const focusedPort = useProcessStore((s) => s.focusedPort);
  const focusedPid = useProcessStore((s) => s.focusedPid);
  const followFocus = useProcessStore((s) => s.followFocus);
  const sortMode = useProcessStore((s) => s.portSortMode);
  const sortReversed = useProcessStore((s) => s.portSortReversed);
  const setFocusedPort = useProcessStore((s) => s.setFocusedPort);
  const expandedPorts = useProcessStore((s) => s.expandedPorts);
  const togglePortExpanded = useProcessStore((s) => s.togglePortExpanded);
  const sortBy = useProcessStore((s) => s.sortPortsBy);
  const listRef = useRef<HTMLElement>(null);
  const focusIndexRef = useRef(0);
  const portsRef = useRef(snapshot?.ports);

  useLayoutEffect(() => {
    // Keep process selection while the first ports snapshot loads.
    if (!snapshot?.ports) return;
    const changed = portsRef.current != null && portsRef.current !== snapshot.ports;
    portsRef.current = snapshot.ports;
    const row = resolveFocusedPort(rows, focusedPort, focusedPid, focusIndexRef.current, changed && !followFocus);
    if ((row?.key ?? null) !== focusedPort || (row?.port.pid ?? null) !== focusedPid) {
      setFocusedPort(row?.key ?? null, row?.port.pid ?? null);
      return;
    }
    const index = rows.findIndex((item) => item.key === focusedPort);
    if (index >= 0) focusIndexRef.current = index;
    listRef.current?.querySelector('[data-port-focused="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [snapshot, focusedPort, focusedPid, followFocus, rows, setFocusedPort]);

  if (snapshot?.ports_error) return <Placeholder isError>{snapshot.ports_error}</Placeholder>;
  if (!snapshot?.ports) return <Placeholder isLoading>Loading ports</Placeholder>;
  if (!rows.length) return <Placeholder>No ports</Placeholder>;

  return (
    <VStack ref={listRef} className="min-h-0 flex-1 overflow-hidden">
      <ScrollableArea label="Port list" axis="both" className="min-h-0 flex-1 overflow-auto">
        <Table density="compact" dividers="none">
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow>
              {COLUMNS.map(({ label, mode }) => (
                <TableHeaderCell key={mode} className="font-normal">
                  <button
                    type="button"
                    aria-label={`Sort by ${PORT_SORT_LABELS[mode]}`}
                    aria-pressed={sortMode === mode}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => sortBy(mode)}
                    className={cn('cursor-pointer text-left hover:text-primary', sortMode === mode && 'text-primary')}
                  >
                    {label}
                    {sortMode === mode && (isPortSortDescending(mode, sortReversed) ? ' ▼' : ' ▲')}
                  </button>
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ key, port, process, sockets, connectionCount }) => (
              <Fragment key={key}>
                <TableRow
                  data-port-focused={key === focusedPort}
                  aria-selected={key === focusedPort}
                  aria-expanded={expandedPorts.has(key)}
                  onDoubleClick={() => togglePortExpanded(key)}
                  onClick={() => setFocusedPort(key, port.pid)}
                  className={cn(
                    'cursor-pointer',
                    key === focusedPort ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
                  )}
                >
                  <TableCell>
                    <HStack gap={1} vAlign="center">
                      <IconButton
                        label={`${expandedPorts.has(key) ? 'Hide' : 'Show'} connections for port ${port.local_port}, PID ${port.pid ?? 'unavailable'}`}
                        tooltip="Show individual sockets and remote endpoints"
                        icon={expandedPorts.has(key) ? <ChevronDown /> : <ChevronRight />}
                        variant="ghost"
                        size="sm"
                        aria-expanded={expandedPorts.has(key)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFocusedPort(key, port.pid);
                          togglePortExpanded(key);
                        }}
                      />
                      <Text type="inherit" color="inherit" className="font-mono">
                        {port.local_port}
                      </Text>
                    </HStack>
                  </TableCell>
                  <TableCell>{port.protocol}</TableCell>
                  <TableCell>{port.local_address}</TableCell>
                  <TableCell>{port.state}</TableCell>
                  <TableCell>{port.pid ?? '—'}</TableCell>
                  <TableCell>
                    <Text type="inherit" color="inherit" textWrap="nowrap">
                      {process?.name || (port.pid === null ? 'Unknown owner' : 'Process unavailable')}
                    </Text>
                  </TableCell>
                  <TableCell>{connectionCount}</TableCell>
                </TableRow>
                {expandedPorts.has(key) && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <VStack gap={2} className="border-y border-border bg-surface px-3 py-2">
                        <Text size="sm" color="secondary">
                          Remote is the address and port at the other end of a connection.
                        </Text>
                        <Table
                          density="compact"
                          dividers="none"
                          aria-label={`Connections for port ${port.local_port}, PID ${port.pid ?? 'unavailable'}`}
                        >
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>PROTOCOL</TableHeaderCell>
                              <TableHeaderCell>LOCAL ADDRESS</TableHeaderCell>
                              <TableHeaderCell>STATE</TableHeaderCell>
                              <TableHeaderCell>REMOTE ADDRESS</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {sockets.map((socket) => (
                              <TableRow key={JSON.stringify(socket)}>
                                <TableCell>{socket.protocol}</TableCell>
                                <TableCell>{socket.local_address}</TableCell>
                                <TableCell>{socket.state}</TableCell>
                                <TableCell>
                                  {socket.remote_address ??
                                    (socket.state === 'LISTEN' ? 'Waiting for connections' : '—')}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </VStack>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </ScrollableArea>
    </VStack>
  );
}
