import { useLayoutEffect, useRef } from 'react';
import { HStack } from '@astryxdesign/core/Layout';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { clsx } from 'clsx';
import { formatBytes, formatCpu } from '@/lib/processFormat';
import { isUsageFolded, usagePortPane, type UsageRow } from '@/lib/paneUsage';
import { resolveFocusedRow } from '@/lib/utils';
import { useProcessStore } from '@/state/processStore';
import { Placeholder } from '../files/Placeholder';

const COLUMNS = [
  { label: 'CPU%', width: 'w-[7ch]', title: 'Sum over the processes; 100% is one core' },
  { label: 'MEM', width: 'w-[7ch]', title: 'Sum of resident memory; shared pages count once per process' },
  { label: 'READ/s', width: 'w-[7ch]', title: 'Disk bytes read per second' },
  { label: 'WRITE/s', width: 'w-[8ch]', title: 'Disk bytes written per second' },
  { label: 'PORTS', width: 'w-[6ch]', title: 'Listening TCP sockets, and UDP sockets below the ephemeral range' },
];

const INDENT = ['', 'pl-4', 'pl-8', 'pl-12'];

// Astryx cells have `max-width: 0` so that they truncate, which only the name should.
const NUMERIC = 'box-content !max-w-none text-right whitespace-nowrap';

const rate = (bytes: number) => (bytes > 0 ? formatBytes(bytes) : '—');

function rowTitle(row: UsageRow): string | undefined {
  const count = row.usage?.processes;
  if (count === undefined) return row.detail ? `${row.label} (${row.detail})` : row.label;
  const processes = `${count} process${count === 1 ? '' : 'es'}`;
  return row.title ? `${row.title}\n${processes}` : processes;
}

export function PaneUsageTable({ rows }: { rows: UsageRow[] }) {
  const focused = useProcessStore((s) => s.focusedUsage);
  const panelActive = useProcessStore((s) => s.panel === 'usage');
  const foldToggles = useProcessStore((s) => s.usageFoldToggles);
  const portsError = useProcessStore((s) => s.snapshot?.ports_error);
  const setFocused = useProcessStore((s) => s.setFocusedUsage);
  const clearScope = useProcessStore((s) => s.clearScope);
  const toggleFold = useProcessStore((s) => s.toggleUsageFold);
  const tableRef = useRef<HTMLTableElement>(null);
  const focusIndexRef = useRef(0);
  const revealedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    // A closed port leaves focus on its pane, so a scope on that pane stays.
    const target = rows.some((row) => row.key === focused) ? focused : usagePortPane(focused);
    const next = resolveFocusedRow(rows, (row) => row.key === target, focusIndexRef.current)?.key ?? null;
    if (next !== focused) {
      // The list mustn't move to a neighbor of what it was scoped to.
      if (next !== target && !panelActive) clearScope();
      setFocused(next);
      return;
    }
    const index = rows.findIndex((row) => row.key === focused);
    if (index >= 0) focusIndexRef.current = index;
    const row = tableRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // A hidden list (phones) can't scroll, and may lose its position.
    if (!row || row.offsetParent === null) {
      revealedRef.current = null;
      return;
    }
    // Only when focus moves: snapshots mustn't undo the user's scrolling.
    if (revealedRef.current === focused) return;
    revealedRef.current = focused;
    // Keep the row clear of the sticky header.
    row.style.scrollMarginTop = `${tableRef.current?.tHead?.offsetHeight ?? 0}px`;
    row.scrollIntoView({ block: 'nearest' });
  }, [focused, panelActive, rows, setFocused, clearScope]);

  return (
    <>
      {portsError && (
        <HStack className="flex-none border-b border-border px-2 py-1">
          <Text size="sm" color="inherit" className="text-error" role="alert">
            {portsError}
          </Text>
        </HStack>
      )}
      <ScrollableArea label="Pane usage list" axis="both" className="min-h-0 flex-1 overflow-auto">
        <Table
          ref={tableRef}
          className="min-w-[56ch]"
          density="compact"
          dividers="none"
          role="treegrid"
          aria-label="Pane usage"
        >
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow>
              <TableHeaderCell className="font-normal">PANE</TableHeaderCell>
              {COLUMNS.map(({ label, width, title }) => (
                <TableHeaderCell key={label} className={clsx(width, NUMERIC, 'font-normal')}>
                  <Tooltip content={title}>
                    <Text type="inherit" color="inherit">
                      {label}
                    </Text>
                  </Tooltip>
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isCollapsed = isUsageFolded(row.key, foldToggles);
              const selected = row.key === focused;
              const highlighted = selected && panelActive;
              const { usage } = row;
              const idle = usage?.processes === 0;
              return (
                <TableRow
                  key={row.key}
                  data-usage-kind={row.kind}
                  aria-level={row.depth + 1}
                  aria-expanded={row.hasChildren ? !isCollapsed : undefined}
                  aria-selected={selected}
                  className={clsx(
                    'cursor-pointer',
                    highlighted
                      ? 'bg-accent-bg text-on-accent'
                      : selected
                        ? 'bg-overlay-hover'
                        : 'hover:bg-overlay-hover',
                    !highlighted && (row.kind === 'port' || idle) && 'text-secondary',
                    row.kind !== 'pane' && row.kind !== 'port' && 'font-medium',
                  )}
                  onClick={() => setFocused(row.key)}
                  onDoubleClick={() => row.hasChildren && toggleFold(row.key)}
                >
                  <TableCell colSpan={usage ? undefined : COLUMNS.length + 1}>
                    <HStack vAlign="center" className={clsx('min-w-0', INDENT[row.depth])}>
                      {row.hasChildren ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`${isCollapsed ? 'Unfold' : 'Fold'} ${row.label}`}
                          className={clsx(
                            'inline-block w-4 shrink-0 cursor-pointer text-left pointer-coarse:w-6',
                            highlighted ? 'text-on-accent/70' : 'text-secondary hover:text-primary',
                          )}
                          onMouseDown={(e) => e.preventDefault()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocused(row.key);
                            toggleFold(row.key);
                          }}
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span className="inline-block w-4 shrink-0 pointer-coarse:w-6" aria-hidden />
                      )}
                      <Tooltip
                        content={
                          <Text type="inherit" color="inherit" className="whitespace-pre-line">
                            {rowTitle(row)}
                          </Text>
                        }
                      >
                        <Text type="inherit" color="inherit" className="truncate">
                          {row.label}
                          {row.detail && (
                            <Text type="inherit" color={highlighted ? 'inherit' : 'secondary'}>
                              {' '}
                              {row.detail}
                            </Text>
                          )}
                        </Text>
                      </Tooltip>
                    </HStack>
                  </TableCell>
                  {usage &&
                    [
                      idle ? '—' : formatCpu(usage.cpu),
                      idle ? '—' : formatBytes(usage.memory),
                      rate(usage.diskRead),
                      rate(usage.diskWrite),
                      portsError ? '?' : usage.ports || '—',
                    ].map((value, column) => (
                      <TableCell key={column} className={clsx(NUMERIC, 'font-mono')}>
                        {value}
                      </TableCell>
                    ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {rows.length === 0 && <Placeholder>No panes</Placeholder>}
      </ScrollableArea>
    </>
  );
}
