import { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Icon } from '@astryxdesign/core/Icon';
import { pathRoot } from '@/lib/utils';
import { useFileStore } from '@/state/fileStore';

interface BreadcrumbProps {
  onNavigate: (path: string, focusTarget?: string) => void;
  /** One line that scrolls sideways, showing the current directory. */
  singleLine?: boolean;
}

export function Breadcrumb({ onNavigate, singleLine = false }: BreadcrumbProps) {
  const currentPath = useFileStore((s) => s.currentPath);
  const root = pathRoot(currentPath);
  const parts = currentPath.slice(root.length).split('/').filter(Boolean);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (singleLine && element) element.scrollLeft = element.scrollWidth;
  }, [singleLine, currentPath]);

  const crumbs = (
    <Breadcrumbs label="Current directory" variant="supporting" separator={<Icon icon={ChevronRight} size="sm" />}>
      <BreadcrumbItem isCurrent={parts.length === 0} onClick={() => onNavigate(root, parts[0])}>
        {root === '/' ? '/' : root.slice(0, 2)}
      </BreadcrumbItem>
      {parts.map((part, i) => {
        const path = root + parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <BreadcrumbItem
            key={path}
            isCurrent={isLast}
            onClick={isLast ? undefined : () => onNavigate(path, parts[i + 1])}
          >
            {part}
          </BreadcrumbItem>
        );
      })}
    </Breadcrumbs>
  );
  if (!singleLine) return crumbs;
  return (
    <div
      ref={scrollRef}
      className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&_li]:shrink-0 [&_ol]:flex-nowrap!"
    >
      {crumbs}
    </div>
  );
}
