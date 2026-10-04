import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { Token } from '@astryxdesign/core/Token';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { cn } from '@/lib/utils';
import { layoutGitGraph, type GitGraphTransition } from '@/lib/gitGraph';
import { useFileStore } from '@/state/fileStore';
import type { GitLogCommit, GitLogRef } from '@/protocol/file-messages';
import { Placeholder } from './Placeholder';

const ROW_HEIGHT = 52;
const LANE_GAP = 18;
const GRAPH_LEFT = 18;
const GRAPH_RIGHT = 16;
const GRAPH_COLORS = [
  'var(--color-text-secondary)',
  'var(--color-text-cyan)',
  'var(--color-text-purple)',
  'var(--color-text-green)',
  'var(--color-text-orange)',
  'var(--color-text-red)',
  'var(--color-text-yellow)',
  'var(--color-text-gray)',
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

function RefLabel({ ref }: { ref: GitLogRef }) {
  return (
    <Token
      size="sm"
      color={ref.kind === 'tag' ? 'yellow' : ref.kind === 'remote' ? 'cyan' : 'green'}
      label={ref.kind === 'tag' ? `tag: ${ref.name}` : ref.name}
    />
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
      <HStack gap={2} vAlign="center" className="flex-none border-b border-border px-3 py-1.5">
        <Icon icon={GitBranch} size="sm" color="secondary" />
        <Text size="sm" weight="medium" color="secondary">
          History
        </Text>
        {gitLog && (
          <Text size="sm" color="secondary" hasTabularNumbers className="ml-auto">
            {gitLog.commits.length}
            {gitLog.truncated ? '+' : ''}
          </Text>
        )}
      </HStack>

      {!gitLog ? (
        <Placeholder isLoading>Loading history…</Placeholder>
      ) : gitStatus && !gitStatus.is_repo ? (
        <Placeholder>Not a git repo</Placeholder>
      ) : gitLog.commits.length === 0 ? (
        <Placeholder>No commits yet</Placeholder>
      ) : (
        <ScrollableArea
          label="Commit history"
          axis="both"
          data-preview-viewport
          className="min-h-0 flex-1 overflow-auto"
        >
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
                const y = rowCenters[rowIndex];
                return (
                  <g key={row.commit.id}>
                    {row.commit.is_head && (
                      <circle cx={x} cy={y} r="8" fill="none" stroke="var(--color-text-yellow)" strokeWidth="1" />
                    )}
                    <circle
                      cx={x}
                      cy={y}
                      r="4.5"
                      fill="var(--color-background-body)"
                      stroke={color}
                      strokeWidth="2.5"
                    />
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
                    selected ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
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
                          commit.is_head ? 'text-yellow-vivid' : selected ? 'text-on-accent/70' : 'text-secondary',
                        )}
                      />
                      <span
                        className={cn('min-w-0 flex-1 truncate text-base font-medium', !selected && 'text-primary')}
                      >
                        {commit.summary}
                      </span>
                      {commit.is_head && <Token size="sm" label="HEAD" />}
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm',
                        selected ? 'text-on-accent/70' : 'text-secondary',
                      )}
                    >
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
        </ScrollableArea>
      )}
    </section>
  );
}
