import type { GitStatusResult } from '../protocol/file-messages';

/** How a worktree differs from its upstream (commits) and HEAD (files). */
export interface GitCounts {
  ahead: number;
  behind: number;
  staged: number;
  changed: number;
  untracked: number;
}

export function gitCounts(status: GitStatusResult): GitCounts {
  return {
    ahead: status.head.ahead,
    behind: status.head.behind,
    staged: status.staged.length,
    changed: status.unstaged.length,
    untracked: status.untracked.length,
  };
}

export function sumGitCounts(counts: GitCounts[]): GitCounts {
  const sum: GitCounts = { ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0 };
  for (const c of counts) {
    sum.ahead += c.ahead;
    sum.behind += c.behind;
    sum.staged += c.staged;
    sum.changed += c.changed;
    sum.untracked += c.untracked;
  }
  return sum;
}

export function sameGitCounts(a: GitCounts, b: GitCounts): boolean {
  return (
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.staged === b.staged &&
    a.changed === b.changed &&
    a.untracked === b.untracked
  );
}

export interface GitIndicator {
  symbol: string;
  label: string;
  className: string;
}

export function gitIndicators(counts: GitCounts): GitIndicator[] {
  const indicators: GitIndicator[] = [];
  if (counts.ahead > 0) {
    indicators.push({ symbol: '↑', label: `${counts.ahead} ahead`, className: 'text-green-vivid' });
  }
  if (counts.behind > 0) {
    indicators.push({ symbol: '↓', label: `${counts.behind} behind`, className: 'text-yellow-vivid' });
  }
  if (counts.staged > 0) {
    indicators.push({ symbol: '+', label: `${counts.staged} staged`, className: 'text-green-vivid' });
  }
  if (counts.changed > 0) {
    indicators.push({ symbol: '~', label: `${counts.changed} changed`, className: 'text-yellow-vivid' });
  }
  if (counts.untracked > 0) {
    indicators.push({ symbol: '?', label: `${counts.untracked} untracked`, className: 'text-secondary' });
  }
  return indicators;
}
