import { ScrollableArea, type ScrollableAreaProps } from '@astryxdesign/core/ScrollableArea';
import { cn } from '@/lib/utils';

export function ScrollArea({ className, ...props }: Omit<ScrollableAreaProps, 'label'> & { label?: string }) {
  return (
    <ScrollableArea
      label="Content"
      axis="both"
      data-slot="scroll-area-viewport"
      {...props}
      className={cn(className, 'overflow-auto')}
    />
  );
}
