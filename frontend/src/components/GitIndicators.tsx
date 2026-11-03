import type { CSSProperties } from 'react';
import { gitIndicators, type GitCounts } from '../lib/gitStatus';

/** Git status symbols, with counts in the tooltip, after an optional branch. */
export function GitIndicators({
  counts,
  branch,
  plain,
  style,
}: {
  counts: GitCounts;
  branch?: string | null;
  /** Inherit the text color, as on a colored badge. */
  plain?: boolean;
  style?: CSSProperties;
}) {
  const indicators = gitIndicators(counts);
  if (!branch && indicators.length === 0) return null;
  const labels = [...(branch ? [`branch ${branch}`] : []), ...indicators.map((indicator) => indicator.label)];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      style={style}
      title={labels.join(', ')}
      aria-label={labels.join(', ')}
    >
      {branch && <span className="min-w-0 max-w-48 truncate text-secondary">⎇ {branch}</span>}
      {indicators.map((indicator) => (
        <span key={indicator.symbol} className={plain ? undefined : indicator.className}>
          {indicator.symbol}
        </span>
      ))}
    </span>
  );
}
