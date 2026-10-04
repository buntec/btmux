import { useFileStore } from '@/state/fileStore';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Placeholder } from '../Placeholder';

export function DiffPreview() {
  const gitDiff = useFileStore((s) => s.gitDiff);

  if (!gitDiff) {
    return <Placeholder>Select a file to view diff</Placeholder>;
  }

  if (gitDiff.is_binary) {
    return <Placeholder>Binary file differs</Placeholder>;
  }

  if (gitDiff.hunks.length === 0) {
    return <Placeholder>No changes</Placeholder>;
  }

  return (
    <ScrollableArea label="Diff" axis="both" data-preview-viewport className="h-full overflow-auto">
      <div className="px-3 py-2 leading-5">
        <div className="mb-2 text-secondary">
          {gitDiff.old_path ? `${gitDiff.old_path} → ${gitDiff.path}` : gitDiff.path}
        </div>
        {gitDiff.hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} className="mb-4">
            <div className="text-purple-vivid mb-1">{hunk.header}</div>
            {hunk.lines.map((line, lineIdx) => {
              let bgClass = '';
              let textClass = '';
              if (line.origin === '+') {
                bgClass = 'bg-green-vivid/15';
                textClass = 'text-green-vivid';
              } else if (line.origin === '-') {
                bgClass = 'bg-red-vivid/15';
                textClass = 'text-red-vivid';
              }

              return (
                <div key={lineIdx} className={`${bgClass} ${textClass} whitespace-pre-wrap break-all px-2`}>
                  <span className="inline-block w-4 select-none text-secondary opacity-60">
                    {line.origin === ' ' ? ' ' : line.origin}
                  </span>
                  {line.content}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </ScrollableArea>
  );
}
