import { useLayoutEffect, useRef } from 'react';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { clsx } from 'clsx';
import { formatBytes, formatCpu } from '@/lib/processFormat';
import { isUsageFolded, resolveFocusedUsage, type UsageRow } from '@/lib/paneUsage';
import { useProcessStore } from '@/state/processStore';
import { Placeholder } from '../files/Placeholder';

const GRID = 'grid gap-x-2 grid-cols-[minmax(14ch,1fr)_7ch_7ch_7ch_8ch_6ch]';

const COLUMNS = [
  { label: 'CPU%', title: 'Sum over the processes; 100% is one core' },
  { label: 'MEM', title: 'Sum of resident memory; shared pages count once per process' },
  { label: 'READ/s', title: 'Disk bytes read per second' },
  { label: 'WRITE/s', title: 'Disk bytes written per second' },
  { label: 'PORTS', title: 'Listening TCP and bound UDP sockets' },
];

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
  const setFocused = useProcessStore((s) => s.setFocusedUsage);
  const toggleFold = useProcessStore((s) => s.toggleUsageFold);
  const listRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const focusIndexRef = useRef(0);

  useLayoutEffect(() => {
    const next = resolveFocusedUsage(rows, focused, focusIndexRef.current);
    if (next !== focused) {
      setFocused(next);
      return;
    }
    const index = rows.findIndex((row) => row.key === focused);
    if (index >= 0) focusIndexRef.current = index;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row) return;
    row.style.scrollMarginTop = `${headerRef.current?.offsetHeight ?? 0}px`;
    row.scrollIntoView({ block: 'nearest' });
  }, [focused, rows, setFocused]);

  return (
    <ScrollableArea label="Pane usage list" axis="both" className="min-h-0 flex-1 overflow-auto">
      <div
        ref={headerRef}
        className={clsx(GRID, 'sticky top-0 z-10 border-b border-border bg-surface px-2 py-1 text-secondary')}
      >
        <span>PANE</span>
        {COLUMNS.map(({ label, title }) => (
          <span key={label} title={title} className="text-right">
            {label}
          </span>
        ))}
      </div>
      <div ref={listRef} role="tree" aria-label="Pane usage">
        {rows.map((row) => {
          const isCollapsed = isUsageFolded(row.key, foldToggles);
          const selected = row.key === focused;
          const highlighted = selected && panelActive;
          const { usage } = row;
          const idle = usage?.processes === 0;
          return (
            <div
              key={row.key}
              data-usage-kind={row.kind}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? !isCollapsed : undefined}
              aria-selected={selected}
              title={rowTitle(row)}
              className={clsx(
                GRID,
                'cursor-pointer items-center px-2 leading-tight pointer-coarse:py-1.5',
                highlighted ? 'bg-accent-bg text-on-accent' : selected ? 'bg-overlay-hover' : 'hover:bg-overlay-hover',
                !highlighted && (row.kind === 'port' || idle) && 'text-secondary',
                row.kind !== 'pane' && row.kind !== 'port' && 'font-medium',
              )}
              onClick={() => setFocused(row.key)}
              onDoubleClick={() => row.hasChildren && toggleFold(row.key)}
            >
              {/* Long titles truncate rather than widen the scrolled content. */}
              <span
                className={clsx('flex min-w-0 items-center [contain:inline-size]', !usage && 'col-span-full')}
                style={{ paddingLeft: `${row.depth * 1.1}rem` }}
              >
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
                <span className="truncate">
                  {row.label}
                  {row.detail && <span className={clsx(!highlighted && 'text-secondary')}> {row.detail}</span>}
                </span>
              </span>
              {usage &&
                [
                  idle ? '—' : formatCpu(usage.cpu),
                  idle ? '—' : formatBytes(usage.memory),
                  rate(usage.diskRead),
                  rate(usage.diskWrite),
                  usage.ports || '—',
                ].map((value, column) => (
                  <span key={column} className="text-right font-mono">
                    {value}
                  </span>
                ))}
            </div>
          );
        })}
        {rows.length === 0 && <Placeholder>No panes</Placeholder>}
      </div>
    </ScrollableArea>
  );
}
