import { Activity } from 'lucide-react';
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
    <div className="flex min-h-0 items-center gap-2 border-b border-border px-2 py-1.5">
      <Activity className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium">Processes</span>
      <span className="truncate text-muted-foreground" style={{ fontSize: '0.85em' }}>
        {processCount} processes
      </span>
      <span className="shrink-0 text-muted-foreground" style={{ fontSize: '0.85em' }}>
        sort: {PROCESS_SORT_LABELS[sortMode]}
      </span>
      <span className="shrink-0 text-muted-foreground" style={{ fontSize: '0.85em' }}>
        {treeMode ? 'tree' : 'flat'}
      </span>
      {followFocus && (
        <span className="shrink-0 text-muted-foreground" style={{ fontSize: '0.85em' }}>
          follow
        </span>
      )}
      {filterActive && (
        <span className="shrink-0 text-muted-foreground" style={{ fontSize: '0.85em' }}>
          filter: <span className="text-foreground">{filterQuery || '...'}</span>
        </span>
      )}
      {snapshot && (
        <span className="ml-auto shrink-0 text-muted-foreground" style={{ fontSize: '0.85em' }}>
          {snapshot.cpu_count} cores · {memoryPercent.toFixed(0)}% / {formatBytes(snapshot.mem_total)} · load{' '}
          {snapshot.load_average[0].toFixed(2)}
        </span>
      )}
      {connectionState !== 'connected' && (
        <span className={cn('shrink-0 text-muted-foreground', animations && 'animate-pulse')} role="status">
          {CONNECTION_STATE_LABEL[connectionState]}
        </span>
      )}
    </div>
  );
}
