import type { ComponentProps, ReactNode } from 'react';
import { LinkProvider } from '@astryxdesign/core/Link';
import { Token, type TokenProps } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
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

/** The rollup's state can count checks its contexts don't list, like a required one never reported. */
function checksSummary(checks: Checks): string {
  if (checks.state === 'failure')
    return checks.failed ? `${checks.failed} of ${checks.total} checks failed` : 'Checks failed';
  if (checks.state === 'pending')
    return checks.pending ? `${checks.pending} of ${checks.total} checks pending` : 'Waiting for required checks';
  return `${checks.total} checks passed`;
}

/** Counts cover every check, names only the first page. */
function names(list: string[], count: number): string {
  const more = count - list.length;
  if (more <= 0) return list.join(', ');
  return list.length ? `${list.join(', ')}, +${more}` : `${more} not listed`;
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
  const [icon, count]: [IconType, number] =
    checks.state === 'failure'
      ? [X, checks.failed]
      : checks.state === 'pending'
        ? [CircleDashed, checks.pending]
        : [Check, 0];
  return (
    <HStack gap={0.5} vAlign="center">
      <Icon icon={icon} size="xsm" />
      {count > 0 && (
        <Text type="inherit" color="inherit" hasTabularNumbers>
          {count}
        </Text>
      )}
    </HStack>
  );
}

/** A line in the tooltip, which sets the text color. */
function Line({ children, isTitle = false }: { children: ReactNode; isTitle?: boolean }) {
  return (
    <Text type="inherit" color="inherit" display="block" weight={isTitle ? 'semibold' : undefined}>
      {children}
    </Text>
  );
}

function details(status: GithubStatus): ReactNode {
  const { pr, checks } = status;
  return (
    <VStack gap={1}>
      {pr ? (
        <>
          <Line isTitle>
            #{pr.number} {pr.title}
          </Line>
          <Line>{[PR_STATES[pr.state], pr.review && REVIEWS[pr.review]].filter(Boolean).join(' · ')}</Line>
        </>
      ) : (
        <Line>No pull request for {status.branch}</Line>
      )}
      {checks && <Line>{checksSummary(checks)}</Line>}
      {checks && checks.failed > 0 && <Line>Failed: {names(checks.failed_names, checks.failed)}</Line>}
      {checks && checks.pending > 0 && <Line>Pending: {names(checks.pending_names, checks.pending)}</Line>}
    </VStack>
  );
}

/** Token has no `target`; the desktop app opens new windows in the default browser. */
function NewTabLink(props: ComponentProps<'a'>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

/** A pane branch's pull request and CI status; links to it on GitHub. */
export function GithubBadge({ status, size = 'md' }: { status: GithubStatus; size?: TokenProps['size'] }) {
  const icon = status.pr ? PR_ICONS[status.pr.state] : GitBranch;
  // The link is the tooltip's first child, so focus shows it and describes the link.
  return (
    <LinkProvider component={NewTabLink}>
      <Tooltip content={details(status)}>
        <Token
          size={size}
          color={color(status)}
          icon={<Icon icon={icon} size="xsm" />}
          label={githubLabel(status)}
          description={[status.pr && PR_STATES[status.pr.state], status.checks && checksSummary(status.checks)]
            .filter(Boolean)
            .join(', ')}
          endContent={status.checks && <ChecksMark checks={status.checks} />}
          href={status.url}
          className="pointer-events-auto"
          onMouseDown={(e) => e.preventDefault()}
        />
      </Tooltip>
    </LinkProvider>
  );
}
