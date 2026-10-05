import { useMemo, type SVGProps } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack } from '@astryxdesign/core/Layout';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { useStore } from '../state/store';
import { getAnimations } from '../state/configDefaults';
import type { AgentState } from '../state/types';

type AgentGroup = 'waiting' | 'working' | 'done' | 'idle';

// Most urgent first; the antenna light shows the first present group.
const GROUPS: AgentGroup[] = ['waiting', 'working', 'done', 'idle'];
const GROUP_OF: Record<AgentState, AgentGroup> = {
  blocked: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'idle',
  unknown: 'idle',
};
const DOT_VARIANT = { waiting: 'warning', working: 'accent', done: 'success', idle: 'neutral' } as const;
const MAX_RAIL_DOTS = 5;

// Lucide's bot with a ball antenna that doubles as a status light.
function AgentGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      overflow="visible"
      {...props}
    >
      <path d="M12 8V5" />
      <circle className="btm-agent-halo" cx="12" cy="3.5" r="1.5" stroke="none" />
      <circle className="btm-agent-light" cx="12" cy="3.5" r="1.5" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}

/** Agents nav entry with live per-state agent indicators. */
export function AgentNavItem({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const allSessions = useStore((state) => state.allSessions);
  const agentPanes = useStore((state) => state.agentPanes);
  const animate = useStore((state) => getAnimations(state.config)) || undefined;
  const agents = useMemo(() => {
    const list: { id: string; group: AgentGroup }[] = [];
    for (const session of allSessions)
      for (const win of session.windows)
        for (const pane of win.panes)
          if (agentPanes.has(pane.id)) list.push({ id: pane.id, group: GROUP_OF[pane.agent_status.state] });
    return list.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  }, [allSessions, agentPanes]);
  const counts = GROUPS.map((group) => [group, agents.filter((agent) => agent.group === group).length] as const).filter(
    ([, count]) => count > 0,
  );
  const summary = counts.map(([group, count]) => `${count} ${group}`).join(', ');

  return (
    <SideNavItem
      // The collapsed rail's tooltip shows the label, so it carries the counts.
      label={collapsed && summary ? `Agents · ${summary}` : 'Agents'}
      aria-label={summary ? `Agents, ${summary}` : undefined}
      icon={
        // Lift the glyph so glyph and rail dots center together.
        <HStack
          className={`relative shrink-0 transition-transform ${collapsed && agents.length > 0 ? '-translate-y-0.5' : ''}`}
        >
          <Icon
            icon={AgentGlyph}
            size="sm"
            color="secondary"
            data-agent-state={agents[0]?.group}
            data-agent-animate={animate}
          />
          {collapsed && agents.length > 0 && (
            <HStack gap={0.5} aria-hidden className="absolute top-full left-1/2 mt-0.5 -translate-x-1/2">
              {agents.slice(0, MAX_RAIL_DOTS).map((agent) => (
                // Keyed by state so each transition replays the entrance.
                <span
                  key={`${agent.id}:${agent.group}`}
                  className="btm-agent-dot size-1 rounded-full"
                  data-agent-state={agent.group}
                  data-agent-animate={animate}
                />
              ))}
            </HStack>
          )}
        </HStack>
      }
      endContent={
        counts.length > 0 ? (
          <HStack gap={2} vAlign="center">
            {counts.map(([group, count]) => (
              <HStack key={group} gap={1} vAlign="center">
                <StatusDot
                  variant={DOT_VARIANT[group]}
                  label={`${count} ${group}`}
                  tooltip={`${count} ${group}`}
                  className="btm-agent-dot"
                  data-agent-state={group}
                  data-agent-animate={animate}
                />
                <Text type="supporting" color="secondary" hasTabularNumbers>
                  {count}
                </Text>
              </HStack>
            ))}
          </HStack>
        ) : undefined
      }
      onClick={onClick}
    />
  );
}
