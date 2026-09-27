import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { layoutGitGraph, type GitGraphTransition } from '@/lib/gitGraph';
import { useFileStore } from '@/state/fileStore';
import type { GitLogCommit, GitLogRef } from '@/protocol/file-messages';

const ROW_HEIGHT = 52;
const LANE_GAP = 18;
const GRAPH_LEFT = 18;
const GRAPH_RIGHT = 16;
const GRAPH_COLORS = [
  'var(--muted-foreground)',
  'var(--color-cyan)',
  'var(--color-magenta)',
  'var(--color-green)',
  'var(--color-orange)',
  'var(--color-red)',
  'var(--color-yellow)',
  'var(--color-brown)',
];

function graphColor(colorIndex: number): string {
  return GRAPH_COLORS[colorIndex % GRAPH_COLORS.length];
}

function laneX(lane: number): number {
  return GRAPH_LEFT + lane * LANE_GAP;
}

function transitionPath(transition: GitGraphTransition, fromY: number, toY: number): string {
  const fromX = laneX(transition.fromLane);
  const toX = laneX(transition.toLane);
  if (fromX === toX) return `M ${fromX} ${fromY} V ${toY}`;

  const bendY = fromY + (toY - fromY) * 0.46;
  return `M ${fromX} ${fromY} C ${fromX} ${bendY}, ${toX} ${bendY}, ${toX} ${toY}`;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function refClassName(ref: GitLogRef): string {
  switch (ref.kind) {
    case 'tag':
      return 'border-theme-yellow/50 text-theme-yellow';
    case 'remote':
      return 'border-theme-cyan/50 text-theme-cyan';
    default:
      return 'border-theme-green/50 text-theme-green';
  }
}

function RefLabel({ ref }: { ref: GitLogRef }) {
  return (
    <Badge variant="outline" className={cn('px-1.5 py-0 text-[0.65rem] font-normal', refClassName(ref))}>
      {ref.kind === 'tag' ? `tag: ${ref.name}` : ref.name}
    </Badge>
  );
}

export function GitHistory() {
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitLog = useFileStore((s) => s.gitLog);
  const gitLogFocusedIndex = useFileStore((s) => s.gitLogFocusedIndex);
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutGitGraph<GitLogCommit>(gitLog?.commits ?? []), [gitLog]);
  const graphWidth = GRAPH_LEFT + Math.max(layout.maxLanes - 1, 0) * LANE_GAP + GRAPH_RIGHT;
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const rowCenters: number[] = [];
  let graphHeight = 0;
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const height = Math.max(ROW_HEIGHT, rowHeights[rowIndex] ?? ROW_HEIGHT);
    rowCenters.push(graphHeight + height / 2);
    graphHeight += height;
  }

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-git-log-index="${gitLogFocusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [gitLogFocusedIndex]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const rows = Array.from(list.querySelectorAll<HTMLDivElement>('[data-git-log-index]'));
    const updateRowHeights = () => {
      const nextHeights = rows.map((row) => row.getBoundingClientRect().height);
      setRowHeights((current) =>
        current.length === nextHeights.length &&
        current.every((height, index) => Math.abs(height - nextHeights[index]) < 0.5)
          ? current
          : nextHeights,
      );
    };

    const observer = new ResizeObserver(updateRowHeights);
    rows.forEach((row) => observer.observe(row));
    updateRowHeights();
    return () => observer.disconnect();
  }, [layout.rows]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="font-medium uppercase tracking-wider">History</span>
        {gitLog && (
          <span className="ml-auto tabular-nums">
            {gitLog.commits.length}
            {gitLog.truncated ? '+' : ''}
          </span>
        )}
      </div>

      {!gitLog ? (
        <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          Loading history…
        </div>
      ) : gitStatus && !gitStatus.is_repo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">Not a git repo</div>
      ) : gitLog.commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">No commits yet</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          <div ref={listRef} className="relative min-w-0 py-1" role="list" aria-label="Git commit history">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-1"
              width={graphWidth}
              height={graphHeight}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
            >
              {layout.rows.flatMap((row, rowIndex) =>
                row.transitions.map((transition, transitionIndex) => (
                  <path
                    key={`${row.commit.id}-${transitionIndex}`}
                    d={transitionPath(transition, rowCenters[rowIndex], rowCenters[rowIndex + 1] ?? graphHeight)}
                    fill="none"
                    stroke={graphColor(transition.colorIndex)}
                    strokeLinecap="round"
                    strokeWidth="2"
                    strokeOpacity="0.8"
                  />
                )),
              )}
              {layout.rows.map((row, rowIndex) => {
                const color = graphColor(row.laneColors[row.lane] ?? 0);
                const x = laneX(row.lane);
                const y = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
                return (
                  <g key={row.commit.id}>
                    {row.commit.is_head && (
                      <circle cx={x} cy={y} r="8" fill="none" stroke="var(--color-yellow)" strokeWidth="1" />
                    )}
                    <circle cx={x} cy={y} r="4.5" fill="var(--background)" stroke={color} strokeWidth="2.5" />
                  </g>
                );
              })}
            </svg>

            {layout.rows.map((row, rowIndex) => {
              const commit = row.commit;
              const date = new Date(commit.timestamp * 1000);
              const selected = rowIndex === gitLogFocusedIndex;
              return (
                <div
                  key={commit.id}
                  role="listitem"
                  data-git-log-index={rowIndex}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => useFileStore.getState().setGitLogFocusedIndex(rowIndex)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 px-2',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                  style={{ minHeight: `${ROW_HEIGHT}px` }}
                  title={`${commit.id}\n${date.toLocaleString()}`}
                >
                  <div className="shrink-0" style={{ width: `${graphWidth}px` }} aria-hidden="true" />
                  <div className="min-w-0 flex-1 py-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <GitCommitHorizontal
                        className={cn(
                          'size-3.5 shrink-0',
                          commit.is_head ? 'text-theme-yellow' : 'text-muted-foreground',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {commit.summary}
                      </span>
                      {commit.is_head && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem] font-normal">
                          HEAD
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem] text-muted-foreground">
                      {commit.refs.map((ref) => (
                        <RefLabel key={`${ref.kind}-${ref.name}`} ref={ref} />
                      ))}
                      <span className="shrink-0 font-mono">{commit.short_id}</span>
                      <span className="truncate">{commit.author}</span>
                      <span className="shrink-0">·</span>
                      <time className="shrink-0" dateTime={date.toISOString()}>
                        {formatDate(commit.timestamp)}
                      </time>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
