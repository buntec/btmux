import { useEffect, useRef, useState } from 'react';
import { Search, File, FileText } from 'lucide-react';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Placeholder } from './Placeholder';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
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
  const searchGenerationRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setError(null);
    if (!searchQuery.trim()) {
      store.getState().setSearchResults([]);
      store.getState().setContentSearchResults([]);
      setIsLoading(false);
      return;
    }
    if (searchMode === 'files') {
      store.getState().setSearchResults([]);
    } else {
      store.getState().setContentSearchResults([]);
    }
    debounceRef.current = setTimeout(async () => {
      if (generation !== searchGenerationRef.current) return;
      setIsLoading(true);
      try {
        if (searchMode === 'files') {
          const resp = await fileSend('search_files', { query: searchQuery, path: '.', root: currentPath });
          const payload = resp.payload as { results: FileSearchResult[] };
          if (generation === searchGenerationRef.current) {
            store.getState().setSearchResults(payload.results ?? []);
          }
        } else {
          const resp = await fileSend('search_content', { query: searchQuery, path: '.', root: currentPath });
          const payload = resp.payload as { results: SearchResult[] };
          if (generation === searchGenerationRef.current) {
            store.getState().setContentSearchResults(payload.results ?? []);
          }
        }
      } catch (err) {
        if (generation === searchGenerationRef.current) {
          const message = err instanceof Error ? err.message : 'Search failed';
          setError(message);
          console.error('search failed:', err);
        }
      } finally {
        if (generation === searchGenerationRef.current) setIsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      searchGenerationRef.current += 1;
    };
  }, [searchQuery, searchMode, currentPath, fileSend, store]);

  const resultCount = searchMode === 'files' ? searchResults.length : contentSearchResults.length;

  useEffect(() => {
    if (resultCount === 0 && focusedIndex !== 0) {
      store.getState().setFocusedIndex(0);
    } else if (focusedIndex >= resultCount && resultCount > 0) {
      store.getState().setFocusedIndex(resultCount - 1);
    }
  }, [focusedIndex, resultCount, store]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const isEmpty =
    !!searchQuery.trim() &&
    !isLoading &&
    (searchMode === 'files' ? searchResults.length === 0 : contentSearchResults.length === 0);

  return (
    <VStack className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <VStack gap={1} className="flex-none border-b border-border px-2 py-1">
        <HStack gap={2} vAlign="center">
          <TextInput
            ref={inputRef}
            label={searchMode === 'files' ? 'Search files' : 'Search content'}
            isLabelHidden
            size="sm"
            startIcon={Search}
            value={searchQuery}
            onChange={(value) => store.getState().setSearchQuery(value)}
            placeholder={searchMode === 'files' ? 'Search files…' : 'Search content…'}
            className="min-w-0 flex-1"
          />
          {isLoading && <Spinner size="sm" aria-label="Searching" />}
        </HStack>
        <SegmentedControl
          label="Search mode"
          size="sm"
          layout="fill"
          value={searchMode}
          onChange={(value) => store.getState().setSearchMode(value as 'files' | 'content')}
          onMouseDown={(e) => e.preventDefault()}
        >
          <SegmentedControlItem value="files" label="Files" />
          <SegmentedControlItem value="content" label="Content" />
        </SegmentedControl>
      </VStack>

      <ScrollableArea label="Search results" axis="both" data-preview-viewport className="min-w-0 flex-1 overflow-auto">
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
          {error && <Placeholder isError>{error}</Placeholder>}
          {!error && isEmpty && <Placeholder>No results</Placeholder>}
          {!searchQuery.trim() && <Placeholder>Type to search</Placeholder>}
        </div>
      </ScrollableArea>
    </VStack>
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
        focused ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
      )}
    >
      <File className="size-3.5 text-secondary shrink-0" />
      <span className="flex-1 truncate">
        {segments.map((seg, k) =>
          seg.hi ? (
            <span key={k} className="text-yellow-vivid">
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
        focused ? 'bg-accent-bg text-on-accent' : 'hover:bg-overlay-hover',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0 leading-tight">
        <FileText className="size-3.5 text-secondary shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {displayPath}
          {result.line != null && (
            <span className={focused ? 'text-on-accent/60' : 'text-secondary'}>:{result.line}</span>
          )}
        </span>
      </div>
      {result.text && (
        <div className={cn('min-w-0 truncate pl-5 leading-tight', focused ? 'text-on-accent/70' : 'text-secondary')}>
          {result.text}
        </div>
      )}
    </div>
  );
}
