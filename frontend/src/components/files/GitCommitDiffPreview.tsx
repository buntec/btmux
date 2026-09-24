import { ScrollArea } from '@/components/ui/scroll-area';
import { useFileStore } from '@/state/fileStore';

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
  const commit = gitLog?.commits[gitLogFocusedIndex];

  if (!commit) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Select a commit</div>;
  }

  if (!gitCommitDiff || gitCommitDiff.commit_id !== commit.id) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading commit diff…</div>;
  }

  if (gitCommitDiff.files.length === 0) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">No changes</div>;
  }

  return (
    <ScrollArea className="h-full">
      <div className="px-3 py-3 leading-5">
        <div className="mb-3 border-b border-border pb-3">
          <div className="text-base font-medium text-foreground">{commit.summary}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{commit.author}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(commit.timestamp * 1000).toISOString()}>{formatDate(commit.timestamp)}</time>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{commit.short_id}</span>
          </div>
        </div>

        {gitCommitDiff.files.map((file) => (
          <section key={`${file.old_path ?? ''}:${file.path}`} className="mb-5 last:mb-0">
            <div className="mb-2 truncate font-mono text-xs text-muted-foreground">
              {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
            </div>

            {file.is_binary ? (
              <div className="text-sm text-muted-foreground">Binary file differs</div>
            ) : file.hunks.length === 0 ? (
              <div className="text-sm text-muted-foreground">No textual changes</div>
            ) : (
              file.hunks.map((hunk, hunkIndex) => (
                <div key={hunkIndex} className="mb-4 last:mb-0">
                  <div className="mb-1 text-[var(--color-magenta)]">{hunk.header}</div>
                  {hunk.lines.map((line, lineIndex) => {
                    const added = line.origin === '+';
                    const removed = line.origin === '-';
                    const bgClass = added ? 'bg-[var(--color-green)]/15' : removed ? 'bg-[var(--color-red)]/15' : '';
                    const textClass = added ? 'text-[var(--color-green)]' : removed ? 'text-[var(--color-red)]' : '';

                    return (
                      <div key={lineIndex} className={`${bgClass} ${textClass} whitespace-pre-wrap break-all px-2`}>
                        <span className="inline-block w-4 select-none text-muted-foreground opacity-60">
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
    </ScrollArea>
  );
}
