import { useId, useMemo, type CSSProperties } from 'react';
import { Icon, type IconSize, type IconType } from '@astryxdesign/core/Icon';
import type { SessionState } from '../state/types';
import { sessionGradient, sessionInitials } from '../lib/sessionIdentity';
import { useStore } from '../state/store';
import { getAnimations } from '../state/configDefaults';
import { useTerminalPalette } from './BtmuxTheme';

const DIRECTIONS = [
  [0, 0, 1, 1],
  [1, 0, 0, 1],
  [1, 1, 0, 0],
  [0, 1, 1, 0],
];

function createSessionIcon(id: string, name: string, flowing: boolean): IconType {
  const glyph = sessionInitials(name);
  return function SessionGlyph(props) {
    const gradientId = useId();
    const clipId = useId();
    const palette = useTerminalPalette();
    const colors = useMemo(() => sessionGradient(id, palette), [palette]);
    // Corner to corner of the tile, in user space.
    const [x1, y1, x2, y2] = DIRECTIONS[colors.direction].map((t) => 1 + 22 * t);
    const [dx, dy] = [2 * (x2 - x1), 2 * (y2 - y1)];
    return (
      <svg viewBox="0 0 24 24" fill="none" {...props}>
        <defs>
          {/* start → end → start over twice the diagonal, so shifting it one period loops. */}
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            spreadMethod="repeat"
            x1={x1}
            y1={y1}
            x2={x1 + dx}
            y2={y1 + dy}
          >
            <stop offset="0" stopColor={colors.start} />
            <stop offset="0.5" stopColor={colors.end} />
            <stop offset="1" stopColor={colors.start} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x="1" y="1" width="22" height="22" rx="5" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {/* Covers the tile at any shift of up to one period. */}
          <rect
            x="-45"
            y="-45"
            width="114"
            height="114"
            fill={`url(#${gradientId})`}
            className="btm-session-flow"
            data-agent-animate={flowing || undefined}
            style={{ '--btm-flow-x': `${dx}px`, '--btm-flow-y': `${dy}px` } as CSSProperties}
          />
        </g>
        <text
          x="12"
          y="12.5"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={Array.from(glyph).length > 1 ? 10 : 13}
          fontWeight={700}
          fill={colors.foreground}
          stroke="none"
        >
          {glyph}
        </text>
      </svg>
    );
  };
}

/** The gradient flows while an agent in the session is working. */
export function SessionIcon({
  session,
  size = 'lg',
}: {
  session: Pick<SessionState, 'id' | 'name' | 'windows'>;
  size?: IconSize;
}) {
  const flowing = useStore(
    (state) =>
      getAnimations(state.config) &&
      session.windows.some((win) =>
        win.panes.some((pane) => state.agentPanes.has(pane.id) && pane.agent_status.state === 'working'),
      ),
  );
  const icon = useMemo(() => createSessionIcon(session.id, session.name, flowing), [session.id, session.name, flowing]);
  return <Icon icon={icon} size={size} />;
}
