import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import type { AgentLimits, LimitSeverity } from '../generated/protocol';
import { formatLimitPercent, formatLimitReset, limitsAreStale } from '../lib/agentUsage';

const VARIANTS: Record<LimitSeverity, 'accent' | 'warning' | 'error'> = {
  normal: 'accent',
  warning: 'warning',
  critical: 'error',
};

export function AgentLimitsPanel({ agents, now }: { agents: AgentLimits[]; now: number }) {
  if (agents.length === 0) return null;
  return (
    <VStack gap={3} className="w-full" data-agent-limits>
      <Heading level={3}>Plan limits</Heading>
      <Grid columns={{ minWidth: 280, max: 2 }} gap={6}>
        {agents.map((agent) => (
          <VStack key={agent.agent} gap={3} className="min-w-0" data-agent-limit-agent={agent.agent}>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Text weight="semibold">{agent.agent}</Text>
              {agent.plan && (
                <Text type="supporting" color="secondary" className="btm-mono">
                  {agent.plan}
                </Text>
              )}
              {limitsAreStale(agent.updated_at, now) && (
                <Text type="supporting" color="secondary" data-agent-limit-stale>
                  Last read{' '}
                  {new Date(agent.updated_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
            </HStack>
            {agent.limits.map((limit) => (
              <VStack key={limit.label} gap={1} data-agent-limit={limit.label} data-severity={limit.severity}>
                <ProgressBar
                  label={limit.label}
                  value={limit.percent}
                  variant={VARIANTS[limit.severity]}
                  hasValueLabel
                  formatValueLabel={formatLimitPercent}
                />
                {limit.resets_at !== null && (
                  <Text type="supporting" color="secondary">
                    {formatLimitReset(limit.resets_at, now)}
                  </Text>
                )}
              </VStack>
            ))}
          </VStack>
        ))}
      </Grid>
      <Text type="supporting" color="secondary">
        For the accounts logged in on this server, including use outside btmux.
      </Text>
    </VStack>
  );
}
