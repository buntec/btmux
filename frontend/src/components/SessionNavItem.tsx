import { useRef, useState, type ReactNode } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Badge } from '@astryxdesign/core/Badge';
import type { SessionState } from '../state/types';
import { SessionIcon } from './SessionIcon';

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
  const triggerRef = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  return (
    <>
      <SideNavItem
        ref={triggerRef}
        label={session.name}
        icon={<SessionIcon session={session} size={collapsed ? 'lg' : 'md'} />}
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
