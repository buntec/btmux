import { GitBranch } from 'lucide-react';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { useFileStore } from '@/state/fileStore';

export function GitModeHeader() {
  const gitStatus = useFileStore((s) => s.gitStatus);
  if (!gitStatus || !gitStatus.is_repo) return null;
  const { head } = gitStatus;

  return (
    <HStack gap={2} vAlign="center" className="min-w-0 flex-none border-b border-border px-2 py-1.5">
      <Icon icon={GitBranch} size="sm" color="secondary" />
      <Text weight="medium" textWrap="nowrap" className="flex-none">
        {head.branch ?? 'detached'}
      </Text>
      {head.commit_sha && (
        <Text type="code" size="sm" color="secondary">
          {head.commit_sha.slice(0, 7)}
        </Text>
      )}
      {head.commit_message && (
        <Text size="sm" color="secondary" maxLines={1} className="min-w-0">
          {head.commit_message}
        </Text>
      )}
    </HStack>
  );
}
