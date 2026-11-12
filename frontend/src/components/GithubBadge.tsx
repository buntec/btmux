import type { ComponentProps, ReactNode, SVGProps } from 'react';
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

// The GitHub mark (github.com/logos), a trademark of GitHub; identifies the service.
function GithubGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 98 96" fill="currentColor" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z"
      />
    </svg>
  );
}

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
  return state === 'open' ? 'blue' : 'gray';
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

/** Short enough for the pane corner; the tooltip has the rest. Null without a PR. */
export function githubLabel(status: GithubStatus): string | null {
  if (!status.pr) return null;
  const parts = [`#${status.pr.number}`];
  const review = status.pr.review;
  if (review === 'approved' || review === 'changes_requested') parts.push(REVIEWS[review]);
  return parts.join(' · ');
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

/** A pane branch on GitHub, with its pull request and CI status; links to it. */
export function GithubBadge({ status, size = 'md' }: { status: GithubStatus; size?: TokenProps['size'] }) {
  const icon = status.pr ? PR_ICONS[status.pr.state] : GitBranch;
  const label = githubLabel(status);
  // The link is the tooltip's first child, so focus shows it and describes the link.
  return (
    <LinkProvider component={NewTabLink}>
      <Tooltip content={details(status)}>
        <Token
          size={size}
          color={color(status)}
          icon={
            <HStack gap={0.5} vAlign="center">
              <Icon icon={GithubGlyph} size="xsm" label="GitHub" />
              <Icon icon={icon} size="xsm" />
            </HStack>
          }
          label={label ?? `Branch ${status.branch}`}
          isLabelHidden={!label}
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
