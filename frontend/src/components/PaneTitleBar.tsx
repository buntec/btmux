import type { AgentState, AgentStatus } from '../state/types';
import type { NotificationLevel } from '../protocol/messages';
import { Token, type TokenProps } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/Layout';
import { StatusDot, type StatusDotProps } from '@astryxdesign/core/StatusDot';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { cn } from '@/lib/utils';

/** Collapse a home-directory prefix to `~` so cwds read like the shell prompt. */
function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const collapsed = cwd.replace(/^\/(?:Users|home)\/[^/]+/, '~');
  return collapsed || cwd;
}

const NOTIFICATION_VARIANTS: Record<NotificationLevel, StatusDotProps['variant']> = {
  attention: 'warning',
  error: 'error',
  success: 'success',
  info: 'accent',
};

interface Props {
  index: number;
  title: string | null | undefined;
  cwd: string | null | undefined;
  agentStatus?: AgentStatus;
  cols: number | null;
  rows: number | null;
  isActive: boolean;
  /** Level of the pending notification for this pane, or null if none. */
  notification: NotificationLevel | null;
  /** LaTeX formulas detected on screen; the chip is hidden at 0. */
  latexCount?: number;
  latexOpen?: boolean;
  onToggleLatex?: () => void;
}

/**
 * Per-pane title bar: title, working directory, LaTeX toggle, notification dot,
 * live cols×rows, agent status, and the pane number. The active pane gets an
 * accent edge and tint.
 */
export function PaneTitleBar({
  index,
  title,
  cwd,
  agentStatus,
  cols,
  rows,
  isActive,
  notification,
  latexCount = 0,
  latexOpen = false,
  onToggleLatex,
}: Props) {
  const label = (title && title.trim()) || 'shell';
  const dir = shortCwd(cwd);
  return (
    <HStack
      gap={2}
      vAlign="center"
      className={cn(
        'flex-none overflow-hidden border-b px-2 py-1',
        isActive ? 'border-b-border-strong border-l-2 border-l-accent bg-accent-muted' : 'border-b-border bg-surface',
      )}
    >
      <Text
        size="sm"
        weight={isActive ? 'semibold' : 'normal'}
        color={isActive ? 'primary' : 'secondary'}
        maxLines={1}
        hasTruncateTooltip={false}
        className="min-w-0"
      >
        {label}
      </Text>
      {dir && (
        <Text size="sm" color="secondary" maxLines={1} hasTruncateTooltip={false} className="min-w-0">
          {dir}
        </Text>
      )}
      <HStack gap={2} vAlign="center" className="ml-auto flex-none">
        {(latexCount > 0 || latexOpen) && (
          <ToggleButton
            size="sm"
            label={`∑ ${latexCount}`}
            tooltip="Toggle LaTeX overlay"
            isPressed={latexOpen}
            onPressedChange={() => onToggleLatex?.()}
            onMouseDown={(e) => e.preventDefault()}
          />
        )}
        {notification && (
          <StatusDot variant={NOTIFICATION_VARIANTS[notification]} label={`${notification} notification`} />
        )}
        {cols && rows ? (
          <Text size="sm" color="secondary" hasTabularNumbers>
            {cols}×{rows}
          </Text>
        ) : null}
        <AgentStatusBadge status={agentStatus} />
        <Token size="sm" color={isActive ? 'blue' : 'gray'} aria-label={`Pane ${index}`} label={String(index)} />
      </HStack>
    </HStack>
  );
}

export function PaneCorner({ index, status, isActive }: { index: number; status?: AgentStatus; isActive: boolean }) {
  return (
    <HStack gap={2} vAlign="center" className="pointer-events-none absolute top-2 right-2 z-3">
      <AgentStatusBadge status={status} />
      <Token color={isActive ? 'blue' : 'gray'} aria-label={`Pane ${index}`} label={String(index)} />
    </HStack>
  );
}

const AGENT_TOKEN_COLORS: Record<Exclude<AgentState, 'unknown'>, TokenProps['color']> = {
  blocked: 'yellow',
  working: 'blue',
  done: 'green',
  idle: 'gray',
};

export function AgentStatusBadge({ status }: { status?: AgentStatus }) {
  if (!status || status.state === 'unknown') return null;
  const label = `${status.agent ? `${status.agent} ` : ''}${status.state}`;
  const token = <Token size="sm" color={AGENT_TOKEN_COLORS[status.state]} label={label} />;
  return status.message ? <Tooltip content={status.message}>{token}</Tooltip> : token;
}
