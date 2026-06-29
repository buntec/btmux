import { useFileStore } from '@/state/fileStore';
import { ScrollArea } from '@/components/ui/scroll-area';

export function DiffPreview() {
  const gitDiff = useFileStore((s) => s.gitDiff);

  if (!gitDiff) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a file to view diff
      </div>
    );
  }

  if (gitDiff.is_binary) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Binary file differs
      </div>
    );
  }

  if (gitDiff.hunks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No changes
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="px-3 py-2 font-mono text-xs leading-5">
        <div className="mb-2 text-muted-foreground">
          {gitDiff.old_path
            ? `${gitDiff.old_path} → ${gitDiff.path}`
            : gitDiff.path}
        </div>
        {gitDiff.hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} className="mb-4">
            <div className="text-[var(--color-magenta)] mb-1">{hunk.header}</div>
            {hunk.lines.map((line, lineIdx) => {
              let bgClass = '';
              let textClass = '';
              if (line.origin === '+') {
                bgClass = 'bg-[var(--color-green)]/15';
                textClass = 'text-[var(--color-green)]';
              } else if (line.origin === '-') {
                bgClass = 'bg-[var(--color-red)]/15';
                textClass = 'text-[var(--color-red)]';
              }

              return (
                <div
                  key={lineIdx}
                  className={`${bgClass} ${textClass} whitespace-pre-wrap break-all px-2`}
                >
                  <span className="inline-block w-4 select-none text-muted-foreground opacity-60">
                    {line.origin === ' ' ? ' ' : line.origin}
                  </span>
                  {line.content}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
