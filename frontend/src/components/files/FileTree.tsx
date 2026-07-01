import { useEffect, useRef } from 'react';
import { Folder, File, ChevronRight } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { FileEntry } from '@/protocol/file-messages';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface FileTreeProps {
  onNavigate: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
}

export function FileTree({ onNavigate, onSelect }: FileTreeProps) {
  const entries = useFileStore((s) => s.entries);
  const currentPath = useFileStore((s) => s.currentPath);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const showDotFiles = useFileStore((s) => s.showDotFiles);
  const isLoading = useFileStore((s) => s.isLoading);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = entries.filter((e) => {
    if (!showDotFiles && e.name.startsWith('.')) return false;
    if (isFilterActive && filterQuery) {
      return e.name.toLowerCase().includes(filterQuery.toLowerCase());
    }
    return true;
  });

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div ref={listRef}>
        {visible.map((entry, i) => (
          <FileRow
            key={entry.name}
            entry={entry}
            index={i}
            focused={i === focusedIndex}
            currentPath={currentPath}
            onNavigate={onNavigate}
            onSelect={onSelect}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-3 py-6 text-center text-muted-foreground">Empty</div>
        )}
      </div>
    </ScrollArea>
  );
}

function FileRow({
  entry,
  index,
  focused,
  currentPath,
  onNavigate,
  onSelect,
}: {
  entry: FileEntry;
  index: number;
  focused: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
}) {
  const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;

  return (
    <div
      data-index={index}
      className={cn(
        'flex items-center gap-2 px-2 cursor-pointer leading-tight',
        focused ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
      onClick={() => {
        if (entry.is_dir) {
          onNavigate(fullPath);
        } else {
          onSelect(fullPath, false);
        }
      }}
    >
      {entry.is_dir ? (
        <Folder className="size-3.5 text-theme-blue shrink-0" />
      ) : (
        <File className="size-3.5 text-muted-foreground shrink-0" />
      )}
      <span className="flex-1 truncate" title={entry.name}>{entry.name}</span>
      {entry.is_dir ? (
        <ChevronRight className="size-3 text-muted-foreground shrink-0" />
      ) : (
        <span className="text-muted-foreground shrink-0" style={{ fontSize: '0.85em' }}>{formatSize(entry.size)}</span>
      )}
    </div>
  );
}
