import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, File, ChevronRight } from 'lucide-react';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { clsx } from 'clsx';
import { joinPath } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { FileEntry, GitStatusResult, ServerFileMessage } from '@/protocol/file-messages';
import { gitCounts } from '@/lib/gitStatus';
import { GitIndicators } from '../GitIndicators';
import { Placeholder } from './Placeholder';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface FileTreeProps {
  fileSend: (type: string, payload: Record<string, unknown>) => Promise<ServerFileMessage>;
  onNavigate: (path: string) => void;
  /** A file was tapped or clicked. */
  onPreview?: () => void;
}

export function FileTree({ fileSend, onNavigate, onPreview }: FileTreeProps) {
  const entries = useFileStore((s) => s.entries);
  const currentPath = useFileStore((s) => s.currentPath);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const previewFullscreen = useFileStore((s) => s.previewFullscreen);
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
        path: joinPath(currentPath, entry.name),
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
    // Focus can move while fullscreen hides the list.
  }, [focusedIndex, previewFullscreen]);

  if (isLoading) {
    return <Placeholder isLoading>Loading…</Placeholder>;
  }

  return (
    <ScrollableArea label="Files" axis="block" data-preview-viewport className="flex-1 overflow-auto">
      <div ref={listRef}>
        {visible.map((entry, i) => {
          const fullPath = joinPath(currentPath, entry.name);
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
              onPreview={onPreview}
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
  onPreview,
}: {
  entry: FileEntry;
  index: number;
  focused: boolean;
  currentPath: string;
  isSelected: boolean;
  isCut: boolean;
  gitStatus: GitStatusResult | undefined;
  onNavigate: (path: string) => void;
  onPreview?: () => void;
}) {
  const fullPath = joinPath(currentPath, entry.name);

  return (
    <div
      data-index={index}
      className={clsx(
        'flex items-center gap-2 px-2 cursor-pointer leading-tight',
        focused ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
        isCut && 'opacity-40',
      )}
      onClick={() => {
        if (entry.is_dir) {
          onNavigate(fullPath);
        } else {
          // Previewing follows focus.
          useFileStore.getState().setFocusedIndex(index);
          onPreview?.();
        }
      }}
    >
      {isSelected ? (
        <span
          className={clsx(
            'size-3.5 shrink-0 flex items-center justify-center',
            focused ? 'text-on-accent' : 'text-blue-vivid',
          )}
          aria-hidden
        >
          ■
        </span>
      ) : entry.is_dir ? (
        <Folder className={clsx('size-3.5 shrink-0', focused ? 'text-on-accent' : 'text-blue-vivid')} />
      ) : (
        <File className={clsx('size-3.5 shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')} />
      )}
      <span className={clsx('flex-1 truncate', isCut && 'line-through decoration-secondary')} title={entry.name}>
        {entry.name}
      </span>
      {gitStatus && <GitStatusIndicators status={gitStatus} />}
      {entry.is_dir ? (
        <ChevronRight className={clsx('size-3 shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')} />
      ) : (
        <span
          className={clsx('shrink-0', focused ? 'text-on-accent/70' : 'text-secondary')}
          style={{ fontSize: '0.85em' }}
        >
          {formatSize(entry.size)}
        </span>
      )}
    </div>
  );
}

function GitStatusIndicators({ status }: { status: GitStatusResult }) {
  // A folder inside a repo has its files' status, not its branch's.
  const counts = gitCounts(status);
  if (!status.is_repo_root) {
    counts.ahead = 0;
    counts.behind = 0;
  }
  return <GitIndicators counts={counts} branch={status.is_repo_root ? status.head.branch : null} size="sm" />;
}
