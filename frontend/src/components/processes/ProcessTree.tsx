import { useLayoutEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
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

const GRID_COLUMNS = 'grid grid-cols-[3.5rem_5rem_4.5rem_4.5rem_5rem_5rem_5.5rem_minmax(0,1fr)]';

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
  return (
    <span className={cn('flex items-center gap-1', active && 'text-foreground')}>
      {label}
      {active && (
        <span
          aria-label={`sorted by ${PROCESS_SORT_LABELS[mode]}`}
          title={`sorted ${isProcessSortDescending(mode) ? 'descending' : 'ascending'}`}
        >
          {isProcessSortDescending(mode) ? '▼' : '▲'}
        </span>
      )}
    </span>
  );
}

export function ProcessTree({ rows }: { rows: ProcessTreeRow[] }) {
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
    const row = listRef.current?.querySelector(`[data-process-pid="${focusedPid}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [focusedPid, followFocus, processes, rows, setFocusedPid]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={cn(GRID_COLUMNS, 'shrink-0 border-b border-border px-2 py-1 text-muted-foreground')}>
        {SORT_COLUMNS.map((column) => (
          <SortHeader key={column.label} label={column.label} mode={column.mode} active={sortMode === column.mode} />
        ))}
        <span>COMMAND</span>
      </div>
      <ScrollArea className="flex-1 overflow-hidden">
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
                  GRID_COLUMNS,
                  'cursor-pointer items-center px-2 leading-tight',
                  focused ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  !match && !focused && 'text-muted-foreground',
                )}
                onClick={() => setFocusedPid(process.pid)}
                onDoubleClick={() => hasChildren && toggleCollapsed(process.pid)}
              >
                <span className="truncate font-mono" title={String(process.pid)}>
                  {process.pid}
                </span>
                <span className="truncate" title={process.user ?? '—'}>
                  {process.user ?? '—'}
                </span>
                <span className={cn('font-mono', process.cpu >= 80 && 'text-theme-red')}>{formatCpu(process.cpu)}</span>
                <span className="font-mono" title={`${formatMemoryPercent(process.memory, memTotal)} of system memory`}>
                  {formatMemoryPercent(process.memory, memTotal)}
                </span>
                <span className="font-mono" title={`${process.memory} bytes`}>
                  {formatBytes(process.memory)}
                </span>
                <span className="font-mono" title={`${process.virtual_memory} bytes`}>
                  {formatBytes(process.virtual_memory)}
                </span>
                <span className="truncate font-mono" title={formatElapsed(process)}>
                  {formatElapsed(process)}
                </span>
                <span
                  className="flex min-w-0 items-center"
                  style={{ paddingLeft: treeMode ? `${depth * 1.1}rem` : undefined }}
                >
                  {treeMode && (
                    <span className="inline-block w-4 shrink-0 text-muted-foreground" aria-hidden>
                      {hasChildren ? (collapsed ? '▸' : '▾') : ' '}
                    </span>
                  )}
                  <span className="truncate" title={process.command}>
                    {process.command || process.name}
                  </span>
                </span>
              </div>
            );
          })}
          {rows.length === 0 && <div className="px-3 py-6 text-center text-muted-foreground">No processes</div>}
        </div>
      </ScrollArea>
    </div>
  );
}
