import { Text, type TextProps } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { gitIndicators, type GitCounts } from '../lib/gitStatus';

/** Git status symbols, with counts in the tooltip, after an optional branch. */
export function GitIndicators({
  counts,
  branch,
  plain,
  size,
}: {
  counts: GitCounts;
  branch?: string | null;
  /** Inherit the text color, as on a colored badge. */
  plain?: boolean;
  size?: TextProps['size'];
}) {
  const indicators = gitIndicators(counts);
  if (!branch && indicators.length === 0) return null;
  const labels = [...(branch ? [`branch ${branch}`] : []), ...indicators.map((indicator) => indicator.label)].join(
    ', ',
  );
  return (
    <Tooltip content={labels}>
      <Text type="inherit" color="inherit" className="inline-flex shrink-0 items-center gap-0.5" aria-label={labels}>
        {branch && (
          <Text type="inherit" size={size} color="secondary" className="min-w-0 max-w-48 truncate">
            ⎇ {branch}
          </Text>
        )}
        {indicators.map((indicator) => (
          <Text
            key={indicator.symbol}
            type="inherit"
            size={size}
            color="inherit"
            className={plain ? undefined : indicator.className}
          >
            {indicator.symbol}
          </Text>
        ))}
      </Text>
    </Tooltip>
  );
}
