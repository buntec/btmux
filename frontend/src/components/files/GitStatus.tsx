import { useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2, GitBranch, FileQuestion, ChevronRight, ChevronDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { GitStatusResult, FileStatus } from '@/protocol/file-messages';

export interface GitItem {
  kind: 'section-header' | 'file';
  section: string;
  path?: string;
  status?: FileStatus;
  count?: number;
}

const SECTION_LABELS: Record<string, string> = {
  staged: 'STAGED CHANGES',
  unstaged: 'UNSTAGED CHANGES',
  untracked: 'UNTRACKED FILES',
};

export function computeGitItems(gitStatus: GitStatusResult, expandedSections: Set<string>): GitItem[] {
  const items: GitItem[] = [];

  if (gitStatus.staged.length > 0) {
    items.push({ kind: 'section-header', section: 'staged', count: gitStatus.staged.length });
    if (expandedSections.has('staged')) {
      for (const entry of gitStatus.staged) {
        items.push({ kind: 'file', section: 'staged', path: entry.path, status: entry.status });
      }
    }
  }

  if (gitStatus.unstaged.length > 0) {
    items.push({ kind: 'section-header', section: 'unstaged', count: gitStatus.unstaged.length });
    if (expandedSections.has('unstaged')) {
      for (const entry of gitStatus.unstaged) {
        items.push({ kind: 'file', section: 'unstaged', path: entry.path, status: entry.status });
      }
    }
  }

  if (gitStatus.untracked.length > 0) {
    items.push({ kind: 'section-header', section: 'untracked', count: gitStatus.untracked.length });
    if (expandedSections.has('untracked')) {
      for (const path of gitStatus.untracked) {
        items.push({ kind: 'file', section: 'untracked', path, status: 'added' });
      }
    }
  }

  return items;
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

export function GitStatus() {
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitFocusedIndex = useFileStore((s) => s.gitFocusedIndex);
  const gitExpandedSections = useFileStore((s) => s.gitExpandedSections);
  const listRef = useRef<HTMLDivElement>(null);

  const items = gitStatus ? computeGitItems(gitStatus, gitExpandedSections) : [];

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

  if (items.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Clean working tree</div>;
  }

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div ref={listRef}>
        {items.map((item, i) => {
          if (item.kind === 'section-header') {
            const expanded = gitExpandedSections.has(item.section);
            return (
              <div
                key={`header-${item.section}`}
                data-git-index={i}
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
                <span className="font-medium">{SECTION_LABELS[item.section] ?? item.section}</span>
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
              className={cn(
                'flex items-center gap-2 px-2 pl-5 cursor-pointer leading-tight',
                i === gitFocusedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
              title={path}
            >
              {statusIcon(item.status!)}
              <span className="truncate">
                {dir && <span className="text-muted-foreground">{dir}</span>}
                {filename}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
