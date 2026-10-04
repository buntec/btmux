import { useId, useMemo } from 'react';
import { Icon, type IconSize, type IconType } from '@astryxdesign/core/Icon';
import type { SessionState } from '../state/types';
import { sessionGradient, sessionInitials } from '../lib/sessionIdentity';
import { useTerminalPalette } from './BtmuxTheme';

function createSessionIcon(id: string, name: string): IconType {
  const glyph = sessionInitials(name);
  return function SessionGlyph(props) {
    const gradientId = useId();
    const palette = useTerminalPalette();
    const colors = useMemo(() => sessionGradient(id, palette), [palette]);
    const directions = [
      [0, 0, 1, 1],
      [1, 0, 0, 1],
      [1, 1, 0, 0],
      [0, 1, 1, 0],
    ];
    const [x1, y1, x2, y2] = directions[colors.direction];
    return (
      <svg viewBox="0 0 24 24" fill="none" {...props}>
        <defs>
          <linearGradient id={gradientId} x1={x1} y1={y1} x2={x2} y2={y2}>
            <stop offset="0" stopColor={colors.start} />
            <stop offset="1" stopColor={colors.end} />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="22" height="22" rx="5" fill={`url(#${gradientId})`} />
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

export function SessionIcon({ session, size = 'lg' }: { session: Pick<SessionState, 'id' | 'name'>; size?: IconSize }) {
  const icon = useMemo(() => createSessionIcon(session.id, session.name), [session.id, session.name]);
  return <Icon icon={icon} size={size} />;
}
