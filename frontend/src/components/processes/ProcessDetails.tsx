import { formatBytes, formatCpu, formatElapsed, formatMemoryPercent, formatStarted } from '@/lib/processFormat';
import { useProcessStore } from '@/state/processStore';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

export function ProcessDetails() {
  const focusedPid = useProcessStore((s) => s.focusedPid);
  const process = useProcessStore((s) => s.processes.find((item) => item.pid === focusedPid));
  const snapshot = useProcessStore((s) => s.snapshot);

  if (!process) {
    return <div className="flex flex-1 items-center justify-center text-muted-foreground">Select a process</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mb-4 flex items-baseline gap-2 border-b border-border pb-2">
        <span className="text-lg font-medium">{process.name || 'Process'}</span>
        <span className="font-mono text-muted-foreground">PID {process.pid}</span>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <Detail label="command" value={process.command} />
        <Detail label="parent" value={process.parent_pid === null ? '—' : String(process.parent_pid)} />
        <Detail label="UID" value={process.user ?? '—'} />
        <Detail label="status" value={process.status} />
        <Detail label="CPU" value={formatCpu(process.cpu)} />
        <Detail
          label="memory"
          value={`${formatBytes(process.memory)} (${formatMemoryPercent(process.memory, snapshot?.mem_total ?? 0)})`}
        />
        <Detail label="virtual memory" value={formatBytes(process.virtual_memory)} />
        <Detail label="elapsed" value={formatElapsed(process)} />
        <Detail label="started" value={formatStarted(process)} />
      </div>
      <div className="mt-6">
        <div className="mb-1 text-muted-foreground">command line</div>
        <pre className="whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/30 p-2 font-mono text-sm">
          {process.command}
        </pre>
      </div>
    </div>
  );
}
