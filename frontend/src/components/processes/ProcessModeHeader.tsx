import { Activity } from 'lucide-react';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { useProcessStore } from '@/state/processStore';
import { formatBytes } from '@/lib/processFormat';
import { PROCESS_SORT_LABELS } from '@/lib/processTree';
import { cn } from '@/lib/utils';
import { CONNECTION_STATE_LABEL, type ConnectionState } from '@/lib/connectionState';

export function ProcessModeHeader({
  connectionState,
  animations,
}: {
  connectionState: ConnectionState;
  animations: boolean;
}) {
  const snapshot = useProcessStore((s) => s.snapshot);
  const processCount = useProcessStore((s) => s.processes.length);
  const sortMode = useProcessStore((s) => s.sortMode);
  const treeMode = useProcessStore((s) => s.treeMode);
  const followFocus = useProcessStore((s) => s.followFocus);
  const filterQuery = useProcessStore((s) => s.filterQuery);
  const filterActive = useProcessStore((s) => s.filterActive);
  const memoryPercent = snapshot && snapshot.mem_total > 0 ? (snapshot.mem_used / snapshot.mem_total) * 100 : 0;

  return (
    <HStack gap={2} vAlign="center" className="min-w-0 flex-1 overflow-hidden">
      <Icon icon={Activity} size="sm" color="secondary" />
      <Text weight="medium" textWrap="nowrap">
        Processes
      </Text>
      <Text size="sm" color="secondary" textWrap="nowrap">
        {processCount}
      </Text>
      <Token size="sm" label={`sort: ${PROCESS_SORT_LABELS[sortMode]}`} />
      <Token size="sm" label={treeMode ? 'tree' : 'flat'} />
      {followFocus && <Token size="sm" color="blue" label="follow" />}
      {filterActive && (
        <Text size="sm" color="secondary" textWrap="nowrap">
          Filter: <Text size="sm">{filterQuery || '…'}</Text>
        </Text>
      )}
      {connectionState !== 'connected' && (
        <Text size="sm" color="secondary" role="status" className={cn(animations && 'animate-pulse')}>
          {CONNECTION_STATE_LABEL[connectionState]}
        </Text>
      )}
      {snapshot && (
        <Text size="sm" color="secondary" textWrap="nowrap" hasTabularNumbers className="ml-auto">
          {snapshot.cpu_count} cores · {memoryPercent.toFixed(0)}% / {formatBytes(snapshot.mem_total)} · load{' '}
          {snapshot.load_average[0].toFixed(2)}
        </Text>
      )}
    </HStack>
  );
}
