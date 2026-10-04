import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { useFileStore } from '@/state/fileStore';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { filterGitLog } from '@/lib/gitGraph';
import { Placeholder } from './Placeholder';

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

export function GitCommitDiffPreview() {
  const gitLog = useFileStore((s) => s.gitLog);
  const gitLogFocusedIndex = useFileStore((s) => s.gitLogFocusedIndex);
  const gitCommitDiff = useFileStore((s) => s.gitCommitDiff);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const commit = filterGitLog(gitLog?.commits ?? [], isFilterActive ? filterQuery : '')[gitLogFocusedIndex];

  if (!commit) {
    return <Placeholder>Select a commit</Placeholder>;
  }

  if (!gitCommitDiff || gitCommitDiff.commit_id !== commit.id) {
    return <Placeholder isLoading>Loading commit diff…</Placeholder>;
  }

  if (gitCommitDiff.files.length === 0) {
    return <Placeholder>No changes</Placeholder>;
  }

  return (
    <ScrollableArea label="Commit diff" axis="both" data-preview-viewport className="h-full overflow-auto">
      <div className="px-3 py-3 leading-5">
        <VStack gap={1} className="mb-3 border-b border-border pb-3">
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

        {gitCommitDiff.files.map((file) => (
          <section key={`${file.old_path ?? ''}:${file.path}`} className="mb-5 last:mb-0">
            <div className="mb-2 truncate font-mono text-xs text-secondary">
              {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
            </div>

            {file.is_binary ? (
              <div className="text-sm text-secondary">Binary file differs</div>
            ) : file.hunks.length === 0 ? (
              <div className="text-sm text-secondary">No textual changes</div>
            ) : (
              file.hunks.map((hunk, hunkIndex) => (
                <div key={hunkIndex} className="mb-4 last:mb-0">
                  <div className="mb-1 text-purple-vivid">{hunk.header}</div>
                  {hunk.lines.map((line, lineIndex) => {
                    const added = line.origin === '+';
                    const removed = line.origin === '-';
                    const bgClass = added ? 'bg-green-vivid/15' : removed ? 'bg-red-vivid/15' : '';
                    const textClass = added ? 'text-green-vivid' : removed ? 'text-red-vivid' : '';

                    return (
                      <div key={lineIndex} className={`${bgClass} ${textClass} whitespace-pre-wrap break-all px-2`}>
                        <span className="inline-block w-4 select-none text-secondary opacity-60">
                          {line.origin === ' ' ? ' ' : line.origin}
                        </span>
                        {line.content}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </section>
        ))}
      </div>
    </ScrollableArea>
  );
}
