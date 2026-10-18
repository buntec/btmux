import { SideNavItem, useSideNavCollapse, type SideNavItemProps } from '@astryxdesign/core/SideNav';
import { Tooltip } from '@astryxdesign/core/Tooltip';

/** A childless SideNavItem whose collapsed rail tooltip works: Astryx's own never attaches to its anchor. */
export function RailNavItem(props: SideNavItemProps) {
  const { isCollapsed } = useSideNavCollapse();
  return (
    <Tooltip content={props.label} placement="end" isEnabled={isCollapsed}>
      <SideNavItem {...props} />
    </Tooltip>
  );
}
