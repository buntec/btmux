import { useState, type ReactNode } from 'react';
import { SideNavItem, useSideNavCollapse } from '@astryxdesign/core/SideNav';
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
  const [folded, setFolded] = useState(false);
  // False in the mobile drawer, which renders items expanded.
  const { isCollapsed: rail } = useSideNavCollapse();
  // No tooltip: the collapsed rail's flyout already names the session.
  return (
    <SideNavItem
      label={session.name}
      icon={<SessionIcon session={session} size={collapsed ? 'lg' : 'md'} />}
      collapsible={{ isCollapsed: folded, onCollapsedChange: setFolded }}
      // One current item: the active window while it's visible, else the session.
      isSelected={isSelected && (collapsed || folded)}
      endContent={<Badge variant="neutral" label={session.windows.length} />}
      onClick={onClick}
      // The rail's flyout trigger drops `onClick` but gets the rest props.
      onClickCapture={rail ? onClick : undefined}
    >
      {children}
    </SideNavItem>
  );
}
