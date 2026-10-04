import { useEffect, useState } from 'react';
import { Folder, File, GitBranch } from 'lucide-react';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import type { FileStatus, GitStatusResult, ServerFileMessage, TreeNode } from '@/protocol/file-messages';
import { Placeholder } from '../Placeholder';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';

interface DirectoryPreviewProps {
  tree: TreeNode;
  path: string | null;
  fileSend: (type: string, payload: Record<string, unknown>) => Promise<ServerFileMessage>;
}

export function DirectoryPreview({ tree, path, fileSend }: DirectoryPreviewProps) {
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(true);

  useEffect(() => {
    if (!path) {
      setGitStatus(null);
      setGitStatusLoading(false);
      return;
    }

    let cancelled = false;
    setGitStatus(null);
    setGitStatusLoading(true);

    void fileSend('git_status', { root: path, path: '.' }).then(
      (response) => {
        if (cancelled) return;
        const status = response.payload as unknown as GitStatusResult;
        setGitStatus(status.is_repo ? status : null);
        setGitStatusLoading(false);
      },
      () => {
        if (!cancelled) setGitStatusLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [path, fileSend]);

  return (
    <div className="flex flex-1 min-h-0">
      <ScrollableArea label="Directory" axis="both" data-preview-viewport className="min-w-0 flex-1 overflow-auto">
        <div className="p-4">
          <TreeNodeRow node={tree} depth={0} />
        </div>
      </ScrollableArea>
      {(gitStatusLoading || gitStatus) && <GitStatusPreview status={gitStatus} loading={gitStatusLoading} />}
    </div>
  );
}

function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <div>
      <div className="flex items-center gap-2 py-px leading-tight" style={{ paddingLeft: `${depth * 16}px` }}>
        {node.is_dir ? (
          <Folder className="size-3.5 text-blue-vivid shrink-0" />
        ) : (
          <File className="size-3.5 text-secondary shrink-0" />
        )}
        <span className={node.is_dir ? 'text-blue-vivid' : 'text-primary'}>{node.name}</span>
      </div>
      {node.children?.map((child) => (
        <TreeNodeRow key={child.name} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

const STATUS_SYMBOLS: Record<FileStatus, string> = {
  added: '+',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  typechange: 'T',
};

function GitStatusPreview({ status, loading }: { status: GitStatusResult | null; loading: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-border">
      <HStack gap={2} vAlign="center" className="min-w-0 flex-none border-b border-border px-3 py-1.5">
        <Icon icon={GitBranch} size="sm" color="secondary" />
        <Text maxLines={1} className="min-w-0">
          {loading ? 'Git status' : (status?.head.branch ?? 'detached')}
        </Text>
      </HStack>
      {loading ? (
        <Placeholder isLoading>Checking git status…</Placeholder>
      ) : status ? (
        <ScrollableArea label="Directory" axis="both" data-preview-viewport className="min-h-0 flex-1 overflow-auto">
          <div className="flex flex-col gap-3 p-3 leading-tight">
            <div className="text-secondary">
              On branch <span className="text-primary">{status.head.branch ?? 'HEAD detached'}</span>
            </div>
            <GitSyncSummary status={status} />
            <GitStatusSection title="Changes to be committed" entries={status.staged} />
            <GitStatusSection title="Changes not staged for commit" entries={status.unstaged} />
            {status.untracked.length > 0 && (
              <div>
                <div className="mb-1 text-secondary">Untracked files</div>
                <div className="flex flex-col gap-px">
                  {status.untracked.map((path) => (
                    <div key={path} className="flex gap-2">
                      <span className="shrink-0 text-secondary">?</span>
                      <span className="truncate">{path}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {status.staged.length === 0 &&
              status.unstaged.length === 0 &&
              status.untracked.length === 0 &&
              status.head.ahead === 0 &&
              status.head.behind === 0 && <div className="text-secondary">Working tree clean</div>}
          </div>
        </ScrollableArea>
      ) : null}
    </div>
  );
}

function GitSyncSummary({ status }: { status: GitStatusResult }) {
  if (status.head.ahead === 0 && status.head.behind === 0) return null;

  if (status.head.ahead > 0 && status.head.behind > 0) {
    return (
      <div className="text-secondary">
        Your branch has <span className="text-green-vivid">↑{status.head.ahead}</span> and{' '}
        <span className="text-yellow-vivid">↓{status.head.behind}</span> commits compared with its upstream.
      </div>
    );
  }

  if (status.head.ahead > 0) {
    return (
      <div className="text-secondary">
        Your branch is <span className="text-green-vivid">↑{status.head.ahead}</span> commits ahead of its upstream.
      </div>
    );
  }

  return (
    <div className="text-secondary">
      Your branch is <span className="text-yellow-vivid">↓{status.head.behind}</span> commits behind its upstream.
    </div>
  );
}

function GitStatusSection({ title, entries }: { title: string; entries: GitStatusResult['staged'] }) {
  if (entries.length === 0) return null;

  return (
    <div>
      <div className="mb-1 text-secondary">{title}</div>
      <div className="flex flex-col gap-px">
        {entries.map((entry) => (
          <div key={`${entry.path}:${entry.status}`} className="flex gap-2">
            <span className="shrink-0 text-secondary">{STATUS_SYMBOLS[entry.status]}</span>
            <span className="truncate">{entry.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
