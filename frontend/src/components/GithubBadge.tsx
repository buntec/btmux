import type { ReactNode } from 'react';
import { Token, type TokenProps } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import {
  Check,
  CircleDashed,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
} from 'lucide-react';
import type { Checks, GithubStatus, PrState, Review } from '../generated/protocol';

const PR_ICONS: Record<PrState, IconType> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const PR_STATES: Record<PrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

const REVIEWS: Record<Review, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  required: 'review required',
};

const CHECK_COLORS: Record<Checks['state'], TokenProps['color']> = {
  success: 'green',
  failure: 'red',
  pending: 'yellow',
};

/** Merged and closed PRs are done, whatever their checks. */
function color(status: GithubStatus): TokenProps['color'] {
  const state = status.pr?.state;
  if (state === 'merged') return 'purple';
  if (state === 'closed') return 'gray';
  if (status.checks) return CHECK_COLORS[status.checks.state];
  return state === 'draft' ? 'gray' : 'blue';
}

function checksSummary(checks: Checks): string {
  if (checks.state === 'failure') return `${checks.failed} of ${checks.total} checks failed`;
  if (checks.state === 'pending') return `${checks.pending} of ${checks.total} checks pending`;
  return `${checks.total} checks passed`;
}

function names(list: string[], count: number): string {
  return list.join(', ') + (count > list.length ? `, +${count - list.length}` : '');
}

/** Short enough for the pane corner; the tooltip has the rest. */
export function githubLabel(status: GithubStatus): string {
  const parts: string[] = [];
  if (status.pr) parts.push(`#${status.pr.number}`);
  const review = status.pr?.review;
  if (review === 'approved' || review === 'changes_requested') parts.push(REVIEWS[review]);
  return parts.join(' · ') || 'checks';
}

function ChecksMark({ checks }: { checks: Checks }) {
  const [icon, count]: [IconType, number | null] =
    checks.state === 'failure'
      ? [X, checks.failed]
      : checks.state === 'pending'
        ? [CircleDashed, checks.pending]
        : [Check, null];
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon icon={icon} size="xsm" />
      {count !== null && <span className="tabular-nums">{count}</span>}
    </span>
  );
}

/** Plain elements: the tooltip sets the text color. */
function details(status: GithubStatus): ReactNode {
  const { pr, checks } = status;
  return (
    <div className="flex flex-col gap-1">
      {pr ? (
        <>
          <div className="font-semibold">
            #{pr.number} {pr.title}
          </div>
          <div>{[PR_STATES[pr.state], pr.review && REVIEWS[pr.review]].filter(Boolean).join(' · ')}</div>
        </>
      ) : (
        <div>No pull request for {status.branch}</div>
      )}
      {checks && <div>{checksSummary(checks)}</div>}
      {checks && checks.failed > 0 && (
        <div className="opacity-80">Failed: {names(checks.failed_names, checks.failed)}</div>
      )}
      {checks && checks.pending > 0 && (
        <div className="opacity-80">Pending: {names(checks.pending_names, checks.pending)}</div>
      )}
    </div>
  );
}

/** A pane branch's pull request and CI status; opens it on GitHub. */
export function GithubBadge({ status, size = 'md' }: { status: GithubStatus; size?: TokenProps['size'] }) {
  const icon = status.pr ? PR_ICONS[status.pr.state] : GitBranch;
  return (
    <Tooltip content={details(status)}>
      <span className="pointer-events-auto inline-flex" onMouseDown={(e) => e.preventDefault()}>
        <Token
          size={size}
          color={color(status)}
          icon={<Icon icon={icon} size="xsm" />}
          label={githubLabel(status)}
          description={[status.pr && PR_STATES[status.pr.state], status.checks && checksSummary(status.checks)]
            .filter(Boolean)
            .join(', ')}
          endContent={status.checks && <ChecksMark checks={status.checks} />}
          onClick={() => window.open(status.url, '_blank', 'noopener,noreferrer')}
        />
      </span>
    </Tooltip>
  );
}
