import type { ReactNode } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
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
  // No tooltip: the collapsed rail's flyout already names the session.
  return (
    <SideNavItem
      label={session.name}
      icon={<SessionIcon session={session} size={collapsed ? 'lg' : 'md'} />}
      collapsible
      isSelected={isSelected}
      endContent={<Badge variant="neutral" label={session.windows.length} />}
      onClick={onClick}
    >
      {children}
    </SideNavItem>
  );
}
