import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Badge } from '@astryxdesign/core/Badge';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import type { SessionState } from '../state/types';
import { sessionGradient, sessionInitials } from '../lib/sessionIdentity';
import { useTerminalPalette } from './BtmuxTheme';

function createSessionIcon(id: string, name: string): IconType {
  const glyph = sessionInitials(name);
  return function SessionIcon(props) {
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

export function SessionNavItem({
  session,
  collapsed,
  isSelected,
  onClick,
  children,
}: {
  session: SessionState;
  collapsed: boolean;
  isSelected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const icon = useMemo(() => createSessionIcon(session.id, session.name), [session.id, session.name]);
  const triggerRef = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  return (
    <>
      <SideNavItem
        ref={triggerRef}
        label={session.name}
        icon={<Icon icon={icon} size={collapsed ? 'lg' : 'md'} />}
        collapsible
        isSelected={isSelected}
        endContent={<Badge variant="neutral" label={session.windows.length} />}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => {
          setFocused(false);
          onClick();
        }}
      >
        {children}
      </SideNavItem>
      <Tooltip
        anchorRef={triggerRef}
        content={session.name}
        placement="end"
        isOpen={collapsed && focused}
        onOpenChange={setFocused}
      />
    </>
  );
}
