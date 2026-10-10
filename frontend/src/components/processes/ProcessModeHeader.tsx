import { Activity, Network } from 'lucide-react';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { Button } from '@astryxdesign/core/Button';
import { useProcessStore } from '@/state/processStore';
import { formatBytes } from '@/lib/processFormat';
import { isPortSortDescending, portKey, PORT_SORT_LABELS } from '@/lib/portRows';
import { isProcessSortDescending, PROCESS_SORT_LABELS } from '@/lib/processTree';
import { cn } from '@/lib/utils';
import { CONNECTION_STATE_LABEL, type ConnectionState } from '@/lib/connectionState';

export function ProcessModeHeader({
  connectionState,
  animations,
}: {
  connectionState: ConnectionState;
  animations: boolean;
}) {
  const viewMode = useProcessStore((s) => s.viewMode);
  const portSortMode = useProcessStore((s) => s.portSortMode);
  const portSortReversed = useProcessStore((s) => s.portSortReversed);
  const setPortSortMode = useProcessStore((s) => s.setPortSortMode);
  const snapshot = useProcessStore((s) => s.snapshot);
  const processCount = useProcessStore((s) => s.processes.length);
  const sortMode = useProcessStore((s) => s.sortMode);
  const sortReversed = useProcessStore((s) => s.sortReversed);
  const treeMode = useProcessStore((s) => s.treeMode);
  const followFocus = useProcessStore((s) => s.followFocus);
  const filterQuery = useProcessStore((s) => s.filterQuery);
  const filterActive = useProcessStore((s) => s.filterActive);
  const memoryPercent = snapshot && snapshot.mem_total > 0 ? (snapshot.mem_used / snapshot.mem_total) * 100 : 0;

  return (
    <HStack gap={2} vAlign="center" className="min-w-0 flex-1 overflow-hidden">
      <Icon icon={viewMode === 'ports' ? Network : Activity} size="sm" color="secondary" />
      <Text weight="medium" textWrap="nowrap">
        {viewMode === 'ports' ? 'Ports' : 'Processes'}
      </Text>
      <Text size="sm" color="secondary" textWrap="nowrap">
        {viewMode === 'ports' ? new Set(snapshot?.ports?.map(portKey)).size : processCount}
      </Text>
      <Token
        size="sm"
        label={
          viewMode === 'ports'
            ? `sort: ${PORT_SORT_LABELS[portSortMode]}${portSortMode === 'listeners' ? '' : isPortSortDescending(portSortMode, portSortReversed) ? ' ▼' : ' ▲'}`
            : `sort: ${PROCESS_SORT_LABELS[sortMode]} ${isProcessSortDescending(sortMode, sortReversed) ? '▼' : '▲'}`
        }
      />
      {viewMode === 'ports' && portSortMode !== 'listeners' && (
        <Button
          label="Sort by listeners first"
          variant="ghost"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setPortSortMode('listeners')}
        >
          Listeners first
        </Button>
      )}
      {viewMode === 'processes' && <Token size="sm" label={treeMode ? 'tree' : 'flat'} />}
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
