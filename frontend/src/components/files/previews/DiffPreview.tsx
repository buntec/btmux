import { useMemo } from 'react';
import { useFileStore } from '@/state/fileStore';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Placeholder } from '../Placeholder';
import { chunkDiffs, DiffRows } from '../DiffRows';

export function DiffPreview() {
  const gitDiff = useFileStore((s) => s.gitDiff);
  const hunks = gitDiff?.hunks;
  const chunks = useMemo(() => chunkDiffs([hunks ?? []])[0], [hunks]);

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
    <ScrollableArea label="Diff" axis="block" data-preview-viewport className="h-full overflow-auto">
      <div className="px-3 py-2 leading-5">
        <div className="mb-2 text-secondary">
          {gitDiff.old_path ? `${gitDiff.old_path} → ${gitDiff.path}` : gitDiff.path}
        </div>
        {/* A new file starts over, so it draws only what it needs. */}
        <DiffRows key={gitDiff.path} chunks={chunks} />
        {gitDiff.truncated && <div className="mt-4 text-secondary">Diff truncated: too large to show in full</div>}
      </div>
    </ScrollableArea>
  );
}
