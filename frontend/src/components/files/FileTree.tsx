import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, File, ChevronRight } from 'lucide-react';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { FileEntry, GitStatusResult, ServerFileMessage } from '@/protocol/file-messages';
import { Placeholder } from './Placeholder';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface FileTreeProps {
  fileSend: (type: string, payload: Record<string, unknown>) => Promise<ServerFileMessage>;
  onNavigate: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
}

export function FileTree({ fileSend, onNavigate, onSelect }: FileTreeProps) {
  const entries = useFileStore((s) => s.entries);
  const currentPath = useFileStore((s) => s.currentPath);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const showDotFiles = useFileStore((s) => s.showDotFiles);
  const showIgnored = useFileStore((s) => s.showIgnored);
  const isLoading = useFileStore((s) => s.isLoading);
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const yankRegister = useFileStore((s) => s.yankRegister);
  const listRef = useRef<HTMLDivElement>(null);
  const [gitStatuses, setGitStatuses] = useState<Map<string, GitStatusResult>>(new Map());

  const cutPaths = yankRegister?.mode === 'cut' ? yankRegister.paths : [];

  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (!showDotFiles && e.name.startsWith('.')) return false;
        if (!showIgnored && e.is_ignored) return false;
        if (isFilterActive && filterQuery) {
          return e.name.toLowerCase().includes(filterQuery.toLowerCase());
        }
        return true;
      }),
    [entries, showDotFiles, showIgnored, isFilterActive, filterQuery],
  );

  useEffect(() => {
    let cancelled = false;
    setGitStatuses(new Map());

    const folders = visible
      .filter((entry) => entry.is_dir)
      .map((entry) => ({
        name: entry.name,
        path: currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`,
      }));

    const loadStatuses = async () => {
      // Keep repository scans asynchronous without flooding the file socket or
      // the backend's blocking-task pool in a large directory.
      for (let i = 0; i < folders.length && !cancelled; i += 8) {
        const batch = folders.slice(i, i + 8);
        await Promise.all(
          batch.map(async (folder) => {
            try {
              const response = await fileSend('git_status', { root: currentPath, path: folder.name });
              if (cancelled) return;
              const status = response.payload as unknown as GitStatusResult;
              if (status.is_repo) {
                setGitStatuses((previous) => new Map(previous).set(folder.path, status));
              }
            } catch {}
          }),
        );
      }
    };

    void loadStatuses();

    return () => {
      cancelled = true;
    };
  }, [currentPath, visible, fileSend]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  if (isLoading) {
    return <Placeholder isLoading>Loading…</Placeholder>;
  }

  return (
    <ScrollableArea label="Files" axis="block" data-preview-viewport className="flex-1 overflow-auto">
      <div ref={listRef}>
        {visible.map((entry, i) => {
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          return (
            <FileRow
              key={entry.name}
              entry={entry}
              index={i}
              focused={i === focusedIndex}
              currentPath={currentPath}
              isSelected={selectedPaths.has(fullPath)}
              isCut={cutPaths.includes(fullPath)}
              gitStatus={gitStatuses.get(fullPath)}
              onNavigate={onNavigate}
              onSelect={onSelect}
            />
          );
        })}
        {visible.length === 0 && <Placeholder>Empty directory</Placeholder>}
      </div>
    </ScrollableArea>
  );
}

function FileRow({
  entry,
  index,
  focused,
  currentPath,
  isSelected,
  isCut,
  gitStatus,
  onNavigate,
  onSelect,
}: {
  entry: FileEntry;
  index: number;
  focused: boolean;
  currentPath: string;
  isSelected: boolean;
  isCut: boolean;
  gitStatus: GitStatusResult | undefined;
  onNavigate: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
}) {
  const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;

  return (
    <div
      data-index={index}
      className={cn(
        'flex items-center gap-2 px-2 cursor-pointer leading-tight',
        focused ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
        isCut && 'opacity-40',
      )}
      onClick={() => {
        if (entry.is_dir) {
          onNavigate(fullPath);
        } else {
          onSelect(fullPath, false);
        }
      }}
    >
      {isSelected ? (
        <span
          className={cn(
            'size-3.5 shrink-0 flex items-center justify-center',
            focused ? 'text-on-accent' : 'text-blue-vivid',
          )}
          aria-hidden
        >
          ■
        </span>
      ) : entry.is_dir ? (
        <Folder className={cn('size-3.5 shrink-0', focused ? 'text-on-accent' : 'text-blue-vivid')} />
      ) : (
        <File className={cn('size-3.5 shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')} />
      )}
      <span className={cn('flex-1 truncate', isCut && 'line-through decoration-secondary')} title={entry.name}>
        {entry.name}
      </span>
      {gitStatus && <GitStatusIndicators status={gitStatus} />}
      {entry.is_dir ? (
        <ChevronRight className={cn('size-3 shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')} />
      ) : (
        <span
          className={cn('shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')}
          style={{ fontSize: '0.85em' }}
        >
          {formatSize(entry.size)}
        </span>
      )}
    </div>
  );
}

function GitStatusIndicators({ status }: { status: GitStatusResult }) {
  const indicators: { symbol: string; label: string; className: string }[] = [];
  const branch = status.is_repo_root ? status.head.branch : null;

  if (status.is_repo_root && status.head.ahead > 0) {
    indicators.push({ symbol: '↑', label: `${status.head.ahead} ahead`, className: 'text-green-vivid' });
  }
  if (status.is_repo_root && status.head.behind > 0) {
    indicators.push({ symbol: '↓', label: `${status.head.behind} behind`, className: 'text-yellow-vivid' });
  }
  if (status.staged.length > 0) {
    indicators.push({ symbol: '+', label: `${status.staged.length} staged`, className: 'text-green-vivid' });
  }
  if (status.unstaged.length > 0) {
    indicators.push({ symbol: '~', label: `${status.unstaged.length} changed`, className: 'text-yellow-vivid' });
  }
  if (status.untracked.length > 0) {
    indicators.push({ symbol: '?', label: `${status.untracked.length} untracked`, className: 'text-secondary' });
  }

  if (!branch && indicators.length === 0) return null;
  const labels = [branch ? `branch ${branch}` : null, ...indicators.map((indicator) => indicator.label)].filter(
    (label): label is string => label !== null,
  );

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      style={{ fontSize: '0.85em' }}
      title={labels.join(', ')}
      aria-label={labels.join(', ')}
    >
      {branch && <span className="min-w-0 max-w-48 truncate text-secondary">⎇ {branch}</span>}
      {indicators.map((indicator) => (
        <span key={indicator.symbol} className={indicator.className}>
          {indicator.symbol}
        </span>
      ))}
    </span>
  );
}
