import { GitBranch } from 'lucide-react';
import { useFileStore } from '@/state/fileStore';

export function GitModeHeader() {
  const gitStatus = useFileStore((s) => s.gitStatus);
  if (!gitStatus || !gitStatus.is_repo) return null;
  const { head } = gitStatus;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 min-h-0">
      <GitBranch className="size-3.5 text-muted-foreground shrink-0" />
      <span className="font-medium">{head.branch ?? 'detached'}</span>
      {head.commit_sha && (
        <span className="text-muted-foreground font-mono" style={{ fontSize: '0.85em' }}>
          {head.commit_sha.slice(0, 7)}
        </span>
      )}
      {head.commit_message && (
        <span className="text-muted-foreground truncate" style={{ fontSize: '0.85em' }}>
          {head.commit_message}
        </span>
      )}
    </div>
  );
}
