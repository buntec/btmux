import { ChevronRight } from 'lucide-react';
import { useFileStore } from '@/state/fileStore';

interface BreadcrumbProps {
  onNavigate: (path: string, focusTarget?: string) => void;
}

export function Breadcrumb({ onNavigate }: BreadcrumbProps) {
  const currentPath = useFileStore((s) => s.currentPath);
  const parts = currentPath.split('/').filter(Boolean);

  return (
    <div className="flex items-center gap-0.5 text-muted-foreground overflow-hidden">
      <button
        className="hover:text-foreground shrink-0 px-1"
        onClick={() => onNavigate('/', parts[0])}
      >
        /
      </button>
      {parts.map((part, i) => {
        const path = '/' + parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <span key={path} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight className="size-3 shrink-0" />
            {isLast ? (
              <span className="text-foreground truncate">{part}</span>
            ) : (
              <button
                className="hover:text-foreground truncate"
                onClick={() => onNavigate(path, parts[i + 1])}
              >
                {part}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
