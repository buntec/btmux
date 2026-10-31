import { useLayoutEffect, useRef } from 'react';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Placeholder } from '../files/Placeholder';
import { cn } from '@/lib/utils';
import { formatBytes, formatCpu, formatElapsed, formatMemoryPercent } from '@/lib/processFormat';
import {
  isProcessSortDescending,
  PROCESS_SORT_LABELS,
  resolveFocusedPid,
  type ProcessSortMode,
  type ProcessTreeRow,
} from '@/lib/processTree';
import { useProcessStore } from '@/state/processStore';

const GRID_COLUMNS = 'grid gap-x-2 grid-cols-[3.5rem_5rem_4.5rem_4.5rem_5rem_5rem_5.5rem_minmax(0,1fr)]';
// Phones show PID, CPU%, MEM%, and the command.
const COMPACT_GRID_COLUMNS = 'grid gap-x-2 grid-cols-[3.5rem_3.5rem_3.5rem_minmax(0,1fr)]';
const COMPACT_LABELS = new Set(['PID', 'CPU%', 'MEM%']);

const SORT_COLUMNS: Array<{ label: string; mode: ProcessSortMode }> = [
  { label: 'PID', mode: 'pid' },
  { label: 'USER', mode: 'user' },
  { label: 'CPU%', mode: 'cpu' },
  { label: 'MEM%', mode: 'memory' },
  { label: 'RES', mode: 'memory' },
  { label: 'VIRT', mode: 'virtual-memory' },
  { label: 'ELAPSED', mode: 'elapsed' },
];

function SortHeader({ label, mode, active }: { label: string; mode: ProcessSortMode; active: boolean }) {
  const sortBy = useProcessStore((s) => s.sortBy);
  const reversed = useProcessStore((s) => s.sortReversed);
  const descending = isProcessSortDescending(mode, reversed);
  return (
    <button
      type="button"
      title={`Sort by ${PROCESS_SORT_LABELS[mode]}`}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => sortBy(mode)}
      className={cn('flex cursor-pointer items-center gap-1 text-left hover:text-primary', active && 'text-primary')}
    >
      {label}
      {active && (
        <span
          aria-label={`sorted by ${PROCESS_SORT_LABELS[mode]}`}
          title={`sorted ${descending ? 'descending' : 'ascending'}`}
        >
          {descending ? '▼' : '▲'}
        </span>
      )}
    </button>
  );
}

export function ProcessTree({
  rows,
  compact = false,
  onDetails,
}: {
  rows: ProcessTreeRow[];
  compact?: boolean;
  /** Called when a row is tapped, to show its details. */
  onDetails?: () => void;
}) {
  const grid = compact ? COMPACT_GRID_COLUMNS : GRID_COLUMNS;
  const columns = compact ? SORT_COLUMNS.filter((column) => COMPACT_LABELS.has(column.label)) : SORT_COLUMNS;
  const processes = useProcessStore((s) => s.processes);
  const focusedPid = useProcessStore((s) => s.focusedPid);
  const followFocus = useProcessStore((s) => s.followFocus);
  const collapsedPids = useProcessStore((s) => s.collapsedPids);
  const sortMode = useProcessStore((s) => s.sortMode);
  const treeMode = useProcessStore((s) => s.treeMode);
  const memTotal = useProcessStore((s) => s.snapshot?.mem_total ?? 0);
  const setFocusedPid = useProcessStore((s) => s.setFocusedPid);
  const toggleCollapsed = useProcessStore((s) => s.toggleCollapsed);
  const listRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const focusIndexRef = useRef(0);
  const processesRef = useRef(processes);

  useLayoutEffect(() => {
    const snapshotChanged = processesRef.current !== processes;
    processesRef.current = processes;
    const nextPid = resolveFocusedPid(rows, focusedPid, focusIndexRef.current, snapshotChanged && !followFocus);
    if (nextPid !== focusedPid) {
      setFocusedPid(nextPid);
      return;
    }
    const index = rows.findIndex((row) => row.process.pid === focusedPid);
    if (index >= 0) focusIndexRef.current = index;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-process-pid="${focusedPid}"]`);
    if (!row) return;
    // Keep the row clear of the sticky header.
    row.style.scrollMarginTop = `${headerRef.current?.offsetHeight ?? 0}px`;
    row.scrollIntoView({ block: 'nearest' });
  }, [focusedPid, followFocus, processes, rows, setFocusedPid]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollableArea
        label="Process list"
        // Wide screens scroll to long commands; phones truncate them.
        axis={compact ? 'block' : 'both'}
        className="min-h-0 flex-1 overflow-auto"
      >
        <div
          ref={headerRef}
          className={cn(grid, 'sticky top-0 z-10 border-b border-border bg-surface px-2 py-1 text-secondary')}
        >
          {columns.map((column) => (
            <SortHeader key={column.label} label={column.label} mode={column.mode} active={sortMode === column.mode} />
          ))}
          <SortHeader label="COMMAND" mode="command" active={sortMode === 'command'} />
        </div>
        <div ref={listRef} role={treeMode ? 'tree' : 'list'} aria-label="Processes">
          {rows.map(({ process, depth, hasChildren, match }) => {
            const collapsed = collapsedPids.has(process.pid);
            const focused = process.pid === focusedPid;
            return (
              <div
                key={process.pid}
                data-process-pid={process.pid}
                role={treeMode ? 'treeitem' : 'listitem'}
                aria-level={treeMode ? depth + 1 : undefined}
                aria-expanded={hasChildren ? !collapsed : undefined}
                aria-selected={focused}
                className={cn(
                  grid,
                  'cursor-pointer items-center px-2 leading-tight pointer-coarse:py-1.5',
                  focused ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
                  !match && !focused && 'text-secondary',
                )}
                onClick={() => {
                  setFocusedPid(process.pid);
                  onDetails?.();
                }}
                onDoubleClick={() => hasChildren && toggleCollapsed(process.pid)}
              >
                <span className="truncate font-mono" title={String(process.pid)}>
                  {process.pid}
                </span>
                {!compact && (
                  <span className="truncate" title={process.user ?? '—'}>
                    {process.user ?? '—'}
                  </span>
                )}
                <span className={cn('font-mono', process.cpu >= 80 && !focused && 'text-red-vivid')}>
                  {formatCpu(process.cpu)}
                </span>
                <span className="font-mono" title={`${formatMemoryPercent(process.memory, memTotal)} of system memory`}>
                  {formatMemoryPercent(process.memory, memTotal)}
                </span>
                {!compact && (
                  <>
                    <span className="font-mono" title={`${process.memory} bytes`}>
                      {formatBytes(process.memory)}
                    </span>
                    <span className="font-mono" title={`${process.virtual_memory} bytes`}>
                      {formatBytes(process.virtual_memory)}
                    </span>
                    <span className="truncate font-mono" title={formatElapsed(process)}>
                      {formatElapsed(process)}
                    </span>
                  </>
                )}
                <span
                  className="flex min-w-0 items-center"
                  style={{ paddingLeft: treeMode ? `${depth * 1.1}rem` : undefined }}
                >
                  {treeMode &&
                    (hasChildren ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`${collapsed ? 'Unfold' : 'Fold'} ${process.name || process.pid}`}
                        className={cn(
                          'inline-block w-4 shrink-0 cursor-pointer text-left pointer-coarse:w-6',
                          focused ? 'text-on-accent/70' : 'text-secondary hover:text-primary',
                        )}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusedPid(process.pid);
                          toggleCollapsed(process.pid);
                        }}
                      >
                        {collapsed ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="inline-block w-4 shrink-0 pointer-coarse:w-6" aria-hidden />
                    ))}
                  <span className="truncate" title={process.command}>
                    {process.command || process.name}
                  </span>
                </span>
              </div>
            );
          })}
          {rows.length === 0 && <Placeholder>No processes</Placeholder>}
        </div>
      </ScrollableArea>
    </div>
  );
}
