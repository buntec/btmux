import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { useFileStore } from '@/state/fileStore';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { List, ListItem } from '@astryxdesign/core/List';
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

  const files = gitCommitDiff.files.map((file) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.origin === '+') additions += 1;
        if (line.origin === '-') deletions += 1;
      }
    }
    return { file, additions, deletions };
  });
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <ScrollableArea label="Commit diff" axis="block" data-preview-viewport className="h-full overflow-auto">
      <VStack padding={3} gap={3} className="leading-5">
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
          {files.length > 0 && (
            <List density="compact" aria-label="Changed files" className="gap-0">
              {files.map(({ file, additions, deletions }) => (
                <ListItem
                  key={`${file.old_path ?? ''}:${file.path}`}
                  className="py-0"
                  label={
                    <Text type="code" size="sm" maxLines={1}>
                      {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
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
                          +{additions}
                        </Text>
                        <Text size="sm" hasTabularNumbers className="text-red-vivid">
                          −{deletions}
                        </Text>
                      </HStack>
                    )
                  }
                />
              ))}
            </List>
          )}
          <Text size="sm" color="secondary" role="status">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed, {additions}{' '}
            {additions === 1 ? 'insertion' : 'insertions'}(+), {deletions} {deletions === 1 ? 'deletion' : 'deletions'}
            (−)
          </Text>
        </VStack>

        {!files.length && <Text color="secondary">No changes</Text>}
        <VStack gap={5}>
          {gitCommitDiff.files.map((file) => (
            <VStack as="section" key={`${file.old_path ?? ''}:${file.path}`} gap={2}>
              <Text type="code" size="sm" weight="medium" maxLines={1}>
                {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
              </Text>

              {file.is_binary ? (
                <Text size="sm" color="secondary">
                  Binary file differs
                </Text>
              ) : file.hunks.length === 0 ? (
                <Text size="sm" color="secondary">
                  No textual changes
                </Text>
              ) : (
                <VStack gap={4}>
                  {file.hunks.map((hunk, hunkIndex) => (
                    <VStack key={hunkIndex} gap={1}>
                      <Text type="inherit" className="text-purple-vivid [overflow-wrap:anywhere]">
                        {hunk.header}
                      </Text>
                      <VStack gap={0}>
                        {hunk.lines.map((line, lineIndex) => {
                          const added = line.origin === '+';
                          const removed = line.origin === '-';
                          const bgClass = added ? 'bg-green-vivid/15' : removed ? 'bg-red-vivid/15' : '';
                          const textClass = added ? 'text-green-vivid' : removed ? 'text-red-vivid' : '';

                          return (
                            <HStack key={lineIndex} gap={0} className={`${bgClass} ${textClass} px-2`}>
                              <Text type="inherit" className="w-4 shrink-0 select-none text-secondary opacity-60">
                                {line.origin === ' ' ? ' ' : line.origin}
                              </Text>
                              <Text
                                type="inherit"
                                color="inherit"
                                className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
                              >
                                {line.content}
                              </Text>
                            </HStack>
                          );
                        })}
                      </VStack>
                    </VStack>
                  ))}
                </VStack>
              )}
            </VStack>
          ))}
        </VStack>
      </VStack>
    </ScrollableArea>
  );
}
