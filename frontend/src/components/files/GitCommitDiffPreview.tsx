import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { useFileStore } from '@/state/fileStore';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { List, ListItem } from '@astryxdesign/core/List';
import { filterGitLog } from '@/lib/gitGraph';
import type { CommitFileDiff } from '@/protocol/file-messages';
import { chunkDiffs, DiffRows } from './DiffRows';
import { Placeholder } from './Placeholder';

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

function fileLabel(file: CommitFileDiff) {
  return file.old_path ? `${file.old_path} → ${file.path}` : file.path;
}

/** Holds `section` at the viewport's top as lazy rows above it draw and wrap, until anything else scrolls. */
function pinToTop(viewport: HTMLElement, content: HTMLElement, section: HTMLElement) {
  let aligned = 0;
  const align = () => {
    viewport.scrollTop += section.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    aligned = viewport.scrollTop;
  };
  const observer = new ResizeObserver(align);
  const onScroll = () => {
    if (Math.abs(viewport.scrollTop - aligned) > 1) release();
  };
  const release = () => {
    observer.disconnect();
    viewport.removeEventListener('scroll', onScroll);
    viewport.style.overflowAnchor = '';
  };
  // Scroll anchoring would look like someone else scrolling.
  viewport.style.overflowAnchor = 'none';
  viewport.addEventListener('scroll', onScroll, { passive: true });
  observer.observe(content);
  align();
  return release;
}

const ChangedFiles = memo(function ChangedFiles({
  files,
  onJump,
}: {
  files: CommitFileDiff[];
  onJump: (path: string) => void;
}) {
  return (
    <List density="compact" aria-label="Changed files" className="gap-0">
      {files.map((file) => (
        <ListItem
          key={`${file.old_path ?? ''}:${file.path}`}
          className="py-0"
          onClick={() => onJump(file.path)}
          label={
            <Text type="code" size="sm" maxLines={1}>
              {fileLabel(file)}
            </Text>
          }
          endContent={
            file.is_binary ? (
              <Text size="sm" color="secondary">
                Binary
              </Text>
            ) : (
              <HStack gap={2} vAlign="center" className="flex-none">
                <Text size="sm" hasTabularNumbers className="text-green-vivid">
                  +{file.additions}
                </Text>
                <Text size="sm" hasTabularNumbers className="text-red-vivid">
                  −{file.deletions}
                </Text>
              </HStack>
            )
          }
        />
      ))}
    </List>
  );
});

const FilePatches = memo(function FilePatches({
  files,
  sections,
}: {
  files: CommitFileDiff[];
  sections: Map<string, HTMLElement>;
}) {
  const chunks = useMemo(() => chunkDiffs(files.map((file) => file.hunks)), [files]);

  return (
    <VStack gap={5}>
      {files.map((file, fileIndex) => (
        <VStack
          as="section"
          key={`${file.old_path ?? ''}:${file.path}`}
          ref={(section) => {
            if (section) sections.set(file.path, section);
            else sections.delete(file.path);
          }}
          gap={2}
        >
          <Text type="code" size="sm" weight="medium" maxLines={1}>
            {fileLabel(file)}
          </Text>

          {file.is_binary ? (
            <Text size="sm" color="secondary">
              Binary file differs
            </Text>
          ) : file.hunks.length === 0 && !file.truncated ? (
            <Text size="sm" color="secondary">
              No textual changes
            </Text>
          ) : (
            <DiffRows chunks={chunks[fileIndex]} />
          )}
          {file.truncated && (
            <Text size="sm" color="secondary">
              Diff truncated
            </Text>
          )}
        </VStack>
      ))}
    </VStack>
  );
});

export function GitCommitDiffPreview() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const releasePin = useRef<(() => void) | null>(null);
  const fileSections = useRef(new Map<string, HTMLElement>());
  const [isScrolled, setIsScrolled] = useState(false);
  const gitLog = useFileStore((s) => s.gitLog);
  const gitLogFocusedIndex = useFileStore((s) => s.gitLogFocusedIndex);
  const gitCommitDiff = useFileStore((s) => s.gitCommitDiff);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const commit = filterGitLog(gitLog?.commits ?? [], isFilterActive ? filterQuery : '')[gitLogFocusedIndex];

  useEffect(() => {
    setIsScrolled(false);
    return () => releasePin.current?.();
  }, [gitCommitDiff?.commit_id]);

  const jumpToFile = useCallback((path: string) => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const section = fileSections.current.get(path);
    if (!viewport || !content || !section) return;
    releasePin.current?.();
    releasePin.current = pinToTop(viewport, content, section);
    viewport.parentElement?.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
  }, []);

  if (!commit) {
    return <Placeholder>Select a commit</Placeholder>;
  }

  if (!gitCommitDiff || gitCommitDiff.commit_id !== commit.id) {
    return <Placeholder isLoading>Loading commit diff…</Placeholder>;
  }

  const { files, total_files: totalFiles, additions, deletions } = gitCommitDiff;

  return (
    <VStack className="relative h-full min-h-0">
      <ScrollableArea
        ref={viewportRef}
        label="Commit diff"
        axis="block"
        data-preview-viewport
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setIsScrolled(event.currentTarget.scrollTop > 0)}
      >
        <VStack ref={contentRef} padding={3} gap={3} className="leading-5">
          <VStack gap={1} className="border-b border-border pb-3">
            <Text type="large" weight="medium">
              {commit.summary}
            </Text>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Text size="sm" color="secondary">
                {commit.author}
              </Text>
              <Text size="sm" color="secondary" aria-hidden="true">
                ·
              </Text>
              <Text size="sm" color="secondary">
                <time dateTime={new Date(commit.timestamp * 1000).toISOString()}>{formatDate(commit.timestamp)}</time>
              </Text>
              <Text size="sm" color="secondary" aria-hidden="true">
                ·
              </Text>
              <Text type="code" size="sm" color="secondary">
                {commit.short_id}
              </Text>
            </HStack>
          </VStack>

          <VStack gap={0} role="region" aria-label="Commit change summary" className="border-b border-border pb-3">
            {files.length > 0 && <ChangedFiles files={files} onJump={jumpToFile} />}
            <Text size="sm" color="secondary" role="status">
              {totalFiles} {totalFiles === 1 ? 'file' : 'files'} changed, {additions}{' '}
              {additions === 1 ? 'insertion' : 'insertions'}(+), {deletions}{' '}
              {deletions === 1 ? 'deletion' : 'deletions'}
              (−)
            </Text>
            {(files.length < totalFiles || files.some((file) => file.truncated)) && (
              <Text size="sm" color="secondary">
                Too large to show in full. For all of it, run{' '}
                <Text type="code" size="sm">
                  {/* The preview diffs against the first parent; `git show` combines a merge's. */}
                  {commit.parents.length > 1
                    ? `git diff ${commit.short_id}^ ${commit.short_id}`
                    : `git show ${commit.short_id}`}
                </Text>
              </Text>
            )}
          </VStack>

          {!files.length && <Text color="secondary">No changes</Text>}
          <FilePatches files={files} sections={fileSections.current} />
        </VStack>
      </ScrollableArea>
      {isScrolled && (
        <Button
          label="Back to top"
          size="sm"
          elevation="low"
          className="absolute top-3 left-1/2 -translate-x-1/2 bg-popover"
          onClick={() => {
            const viewport = viewportRef.current;
            if (!viewport) return;
            viewport.scrollTop = 0;
            viewport.parentElement?.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
            setIsScrolled(false);
          }}
        />
      )}
    </VStack>
  );
}
