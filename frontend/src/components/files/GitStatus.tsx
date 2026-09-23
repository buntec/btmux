import { useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2, GitBranch, FileQuestion, ChevronRight, ChevronDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { GitStatusResult, FileStatus, LineStats } from '@/protocol/file-messages';

export interface GitItem {
  kind: 'section-header' | 'file';
  section: string;
  path?: string;
  status?: FileStatus;
  additions?: number;
  deletions?: number;
  count?: number;
}

const SECTION_LABELS: Record<string, string> = {
  staged: 'STAGED CHANGES',
  unstaged: 'UNSTAGED CHANGES',
  untracked: 'UNTRACKED FILES',
};

export const ALL_GIT_SECTIONS = new Set(['staged', 'unstaged', 'untracked']);

export function computeGitItems(gitStatus: GitStatusResult, expandedSections: Set<string>): GitItem[] {
  const items: GitItem[] = [];

  if (gitStatus.staged.length > 0) {
    items.push({
      kind: 'section-header',
      section: 'staged',
      count: gitStatus.staged.length,
      additions: gitStatus.staged.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: gitStatus.staged.reduce((sum, entry) => sum + entry.deletions, 0),
    });
    if (expandedSections.has('staged')) {
      for (const entry of gitStatus.staged) {
        items.push({
          kind: 'file',
          section: 'staged',
          path: entry.path,
          status: entry.status,
          additions: entry.additions,
          deletions: entry.deletions,
        });
      }
    }
  }

  if (gitStatus.unstaged.length > 0) {
    items.push({
      kind: 'section-header',
      section: 'unstaged',
      count: gitStatus.unstaged.length,
      additions: gitStatus.unstaged.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: gitStatus.unstaged.reduce((sum, entry) => sum + entry.deletions, 0),
    });
    if (expandedSections.has('unstaged')) {
      for (const entry of gitStatus.unstaged) {
        items.push({
          kind: 'file',
          section: 'unstaged',
          path: entry.path,
          status: entry.status,
          additions: entry.additions,
          deletions: entry.deletions,
        });
      }
    }
  }

  if (gitStatus.untracked.length > 0) {
    items.push({
      kind: 'section-header',
      section: 'untracked',
      count: gitStatus.untracked.length,
      additions: gitStatus.untracked.reduce((sum, path) => sum + (gitStatus.untracked_stats[path]?.additions ?? 0), 0),
      deletions: gitStatus.untracked.reduce((sum, path) => sum + (gitStatus.untracked_stats[path]?.deletions ?? 0), 0),
    });
    if (expandedSections.has('untracked')) {
      for (const path of gitStatus.untracked) {
        const stats = gitStatus.untracked_stats[path];
        items.push({
          kind: 'file',
          section: 'untracked',
          path,
          status: 'added',
          additions: stats?.additions ?? 0,
          deletions: stats?.deletions ?? 0,
        });
      }
    }
  }

  return items;
}

/** Drops non-matching file items and any section header left with no matches. */
export function filterGitItems(items: GitItem[], query: string): GitItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const result: GitItem[] = [];
  let headerIndex = -1;
  let matched = false;

  const commitHeader = () => {
    if (headerIndex !== -1 && !matched) {
      result.splice(headerIndex, 1);
    }
    headerIndex = -1;
    matched = false;
  };

  for (const item of items) {
    if (item.kind === 'section-header') {
      commitHeader();
      result.push(item);
      headerIndex = result.length - 1;
    } else if (item.path?.toLowerCase().includes(q)) {
      result.push(item);
      matched = true;
    }
  }
  commitHeader();
  return result;
}

function statusIcon(status: FileStatus) {
  switch (status) {
    case 'added':
      return <Plus className="size-3 text-[var(--color-green)] shrink-0" />;
    case 'modified':
      return <Pencil className="size-3 text-[var(--color-yellow)] shrink-0" />;
    case 'deleted':
      return <Trash2 className="size-3 text-[var(--color-red)] shrink-0" />;
    case 'renamed':
      return <GitBranch className="size-3 text-[var(--color-magenta)] shrink-0" />;
    case 'typechange':
      return <FileQuestion className="size-3 text-[var(--color-yellow)] shrink-0" />;
  }
}

function DiffStat({ additions, deletions, showZeroes = false }: LineStats & { showZeroes?: boolean }) {
  const total = additions + deletions;
  if (total === 0 && !showZeroes) return null;

  const additionsWidth = total > 0 ? `${(additions / total) * 100}%` : '0%';
  const deletionsWidth = total > 0 ? `${(deletions / total) * 100}%` : '0%';

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[0.7em] tabular-nums whitespace-nowrap"
      title={`${additions} additions, ${deletions} deletions`}
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      {total > 0 && (
        <span className="inline-flex h-1.5 w-8 overflow-hidden rounded-full bg-muted/60" aria-hidden="true">
          {additions > 0 && <span className="bg-[var(--color-green)]" style={{ width: additionsWidth }} />}
          {deletions > 0 && <span className="bg-[var(--color-red)]" style={{ width: deletionsWidth }} />}
        </span>
      )}
      {(additions > 0 || showZeroes) && <span className="text-[var(--color-green)]">+{additions}</span>}
      {(deletions > 0 || showZeroes) && <span className="text-[var(--color-red)]">-{deletions}</span>}
    </span>
  );
}

export function GitStatus() {
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitFocusedIndex = useFileStore((s) => s.gitFocusedIndex);
  const gitExpandedSections = useFileStore((s) => s.gitExpandedSections);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const listRef = useRef<HTMLDivElement>(null);

  const expandedSections = isFilterActive ? ALL_GIT_SECTIONS : gitExpandedSections;
  const items = gitStatus
    ? filterGitItems(computeGitItems(gitStatus, expandedSections), isFilterActive ? filterQuery : '')
    : [];

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-git-index="${gitFocusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [gitFocusedIndex]);

  if (!gitStatus) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!gitStatus.is_repo) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Not a git repo</div>;
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          {isFilterActive && filterQuery ? 'No matches' : 'Clean working tree'}
        </div>
      ) : (
        <ScrollArea className="flex-1 overflow-hidden">
          <div ref={listRef}>
            {items.map((item, i) => {
              if (item.kind === 'section-header') {
                const expanded = expandedSections.has(item.section);
                return (
                  <div
                    key={`header-${item.section}`}
                    data-git-index={i}
                    onClick={() => useFileStore.getState().setGitFocusedIndex(i)}
                    className={cn(
                      'flex items-center gap-1.5 px-2 cursor-pointer select-none text-muted-foreground leading-tight',
                      i === gitFocusedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {SECTION_LABELS[item.section] ?? item.section}
                    </span>
                    <DiffStat additions={item.additions ?? 0} deletions={item.deletions ?? 0} showZeroes />
                  </div>
                );
              }

              const path = item.path || '';
              const lastSlash = path.lastIndexOf('/');
              const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
              const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
              return (
                <div
                  key={`${item.section}-${item.path}`}
                  data-git-index={i}
                  onClick={() => useFileStore.getState().setGitFocusedIndex(i)}
                  className={cn(
                    'flex items-center gap-2 px-2 pl-5 cursor-pointer leading-tight',
                    i === gitFocusedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                  title={path}
                >
                  {statusIcon(item.status!)}
                  <span className="min-w-0 flex-1 truncate">
                    {dir && <span className="text-muted-foreground">{dir}</span>}
                    {filename}
                  </span>
                  <DiffStat additions={item.additions ?? 0} deletions={item.deletions ?? 0} />
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
