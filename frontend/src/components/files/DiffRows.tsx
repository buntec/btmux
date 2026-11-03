import { memo, useEffect, useRef, useState } from 'react';
import type { DiffHunk, DiffLine } from '@/protocol/file-messages';

const CHUNK_ROWS = 200;
/** Rows drawn at once, more than a screen, so ordinary diffs don't flash. */
const EAGER_ROWS = 200;
/** `leading-5` */
const ROW_REM = 1.25;

type HeaderRow = { header: string; first: boolean };
type DiffRow = HeaderRow | DiffLine;
export type DiffRowChunk = { rows: DiffRow[]; eager: boolean };

function isHeader(row: DiffRow): row is HeaderRow {
  return 'header' in row;
}

/** Each file's rows in chunks; only the first rows across all files draw at once. */
export function chunkDiffs(files: DiffHunk[][]): DiffRowChunk[][] {
  let drawn = 0;
  return files.map((hunks) => {
    const rows: DiffRow[] = hunks.flatMap((hunk, index) => [
      { header: hunk.header, first: index === 0 },
      ...hunk.lines,
    ]);
    const chunks: DiffRowChunk[] = [];
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
      const chunk = rows.slice(start, start + CHUNK_ROWS);
      chunks.push({ rows: chunk, eager: drawn < EAGER_ROWS });
      drawn += chunk.length;
    }
    return chunks;
  });
}

/** Plain elements: a diff can have tens of thousands of rows. Drawn when near the viewport, then kept for selection. */
const Chunk = memo(function Chunk({ rows, eager }: DiffRowChunk) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(eager);

  useEffect(() => {
    const element = ref.current;
    if (shown || !element) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown(true), {
      root: element.closest('[data-preview-viewport]'),
      rootMargin: '100% 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);

  if (!shown) {
    const headers = rows.filter(isHeader).length;
    // Headers add `mt-4 mb-1`.
    return <div ref={ref} style={{ height: `${(rows.length + headers) * ROW_REM}rem` }} />;
  }

  return (
    <div>
      {rows.map((row, index) => {
        if (isHeader(row)) {
          return (
            <div key={index} className={`${row.first ? '' : 'mt-4'} mb-1 text-purple-vivid [overflow-wrap:anywhere]`}>
              {row.header}
            </div>
          );
        }
        const added = row.origin === '+';
        const removed = row.origin === '-';
        const color = added ? 'bg-green-vivid/15 text-green-vivid' : removed ? 'bg-red-vivid/15 text-red-vivid' : '';
        return (
          <div key={index} className={`${color} flex px-2`}>
            <span className="w-4 shrink-0 select-none text-secondary opacity-60">
              {row.origin === ' ' ? ' ' : row.origin}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.content}</span>
          </div>
        );
      })}
    </div>
  );
});

export function DiffRows({ chunks }: { chunks: DiffRowChunk[] }) {
  return (
    <div>
      {chunks.map((chunk, index) => (
        <Chunk key={index} rows={chunk.rows} eager={chunk.eager} />
      ))}
    </div>
  );
}
