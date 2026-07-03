import { useEffect, useRef, useState } from 'react';
import { Search, Loader2, File, FileText } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';
import type { FileSearchResult, SearchResult, ServerFileMessage } from '@/protocol/file-messages';

interface FileSearchProps {
  fileSend: (type: string, payload: Record<string, unknown>) => Promise<ServerFileMessage>;
  currentPath: string;
  focusedIndex: number;
}

export function FileSearch({ fileSend, currentPath, focusedIndex }: FileSearchProps) {
  const searchMode = useFileStore((s) => s.searchMode);
  const searchQuery = useFileStore((s) => s.searchQuery);
  const searchResults = useFileStore((s) => s.searchResults);
  const contentSearchResults = useFileStore((s) => s.contentSearchResults);
  const store = useFileStore;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim()) {
      store.getState().setSearchResults([]);
      store.getState().setContentSearchResults([]);
      setIsLoading(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        if (searchMode === 'files') {
          const resp = await fileSend('search_files', { query: searchQuery, path: '.', root: currentPath });
          const payload = resp.payload as { results: FileSearchResult[] };
          store.getState().setSearchResults(payload.results ?? []);
        } else {
          const resp = await fileSend('search_content', { query: searchQuery, path: '.', root: currentPath });
          const payload = resp.payload as { results: SearchResult[] };
          store.getState().setContentSearchResults(payload.results ?? []);
        }
      } catch (err) {
        console.error('search failed:', err);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, searchMode, currentPath, fileSend, store]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const isEmpty =
    !!searchQuery.trim() &&
    !isLoading &&
    (searchMode === 'files' ? searchResults.length === 0 : contentSearchResults.length === 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border">
        {isLoading ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" />
        ) : (
          <Search className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => store.getState().setSearchQuery(e.target.value)}
          placeholder={searchMode === 'files' ? 'Search files…' : 'Search content…'}
          className="flex-1 bg-transparent outline-none min-w-0"
          spellCheck={false}
        />
        <button
          onClick={() => {
            store.getState().setSearchMode(searchMode === 'files' ? 'content' : 'files');
          }}
          className="text-muted-foreground hover:text-foreground shrink-0 leading-none"
          style={{ fontSize: '0.75em' }}
          tabIndex={-1}
        >
          {searchMode === 'files' ? 'files' : 'content'}
        </button>
      </div>

      <ScrollArea className="flex-1 overflow-hidden">
        <div ref={listRef}>
          {searchMode === 'files' &&
            searchResults.map((r, i) => (
              <FileResultRow key={r.path} result={r} root={currentPath} index={i} focused={i === focusedIndex} />
            ))}
          {searchMode === 'content' &&
            contentSearchResults.map((r, i) => (
              <ContentResultRow
                key={`${r.path}:${r.line ?? ''}:${i}`}
                result={r}
                root={currentPath}
                index={i}
                focused={i === focusedIndex}
              />
            ))}
          {isEmpty && <div className="px-3 py-4 text-center text-muted-foreground">No results</div>}
          {!searchQuery.trim() && <div className="px-3 py-4 text-center text-muted-foreground">Type to search</div>}
        </div>
      </ScrollArea>
    </div>
  );
}

function FileResultRow({
  result,
  root,
  index,
  focused,
}: {
  result: FileSearchResult;
  root: string;
  index: number;
  focused: boolean;
}) {
  const displayPath = result.path.startsWith(root + '/') ? result.path.slice(root.length + 1) : result.path;
  const offset = result.path.length - displayPath.length;
  const highlighted = new Set(result.indices.map((i) => i - offset));

  const segments: { text: string; hi: boolean }[] = [];
  let i = 0;
  while (i < displayPath.length) {
    const h = highlighted.has(i);
    let j = i + 1;
    while (j < displayPath.length && highlighted.has(j) === h) j++;
    segments.push({ text: displayPath.slice(i, j), hi: h });
    i = j;
  }

  return (
    <div
      data-index={index}
      className={cn(
        'flex items-center gap-2 px-2 leading-tight cursor-default select-none',
        focused ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <File className="size-3.5 text-muted-foreground shrink-0" />
      <span className="flex-1 truncate">
        {segments.map((seg, k) =>
          seg.hi ? (
            <span key={k} className="text-yellow-400">
              {seg.text}
            </span>
          ) : (
            <span key={k}>{seg.text}</span>
          ),
        )}
      </span>
    </div>
  );
}

function ContentResultRow({
  result,
  root,
  index,
  focused,
}: {
  result: SearchResult;
  root: string;
  index: number;
  focused: boolean;
}) {
  const displayPath = result.path.startsWith(root + '/') ? result.path.slice(root.length + 1) : result.path;

  return (
    <div
      data-index={index}
      className={cn(
        'flex flex-col px-2 py-0.5 cursor-default select-none',
        focused ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0 leading-tight">
        <FileText className="size-3.5 text-muted-foreground shrink-0" />
        <span className="truncate">
          {displayPath}
          {result.line != null && (
            <span className={focused ? 'text-accent-foreground/60' : 'text-muted-foreground'}>:{result.line}</span>
          )}
        </span>
      </div>
      {result.text && (
        <div
          className={cn('pl-5 truncate leading-tight', focused ? 'text-accent-foreground/70' : 'text-muted-foreground')}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}
