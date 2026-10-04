import { HStack, VStack } from '@astryxdesign/core/Layout';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { formatBytes, formatCpu, formatElapsed, formatMemoryPercent, formatStarted } from '@/lib/processFormat';
import { useProcessStore } from '@/state/processStore';
import { Placeholder } from '../files/Placeholder';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap={3} className="min-w-0">
      <Text color="secondary" className="w-32 flex-none">
        {label}
      </Text>
      <Text maxLines={1} className="min-w-0 flex-1">
        {value}
      </Text>
    </HStack>
  );
}

export function ProcessDetails() {
  const focusedPid = useProcessStore((s) => s.focusedPid);
  const process = useProcessStore((s) => s.processes.find((item) => item.pid === focusedPid));
  const snapshot = useProcessStore((s) => s.snapshot);

  if (!process) return <Placeholder>Select a process</Placeholder>;

  return (
    <ScrollableArea label="Process details" padding={4} className="min-h-0 flex-1">
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" className="min-w-0 border-b border-border pb-2">
          <Text type="large" weight="medium" maxLines={1} className="min-w-0">
            {process.name || 'Process'}
          </Text>
          <Text type="code" size="sm" color="secondary" textWrap="nowrap">
            PID {process.pid}
          </Text>
        </HStack>
        <VStack gap={2}>
          <Detail label="Command" value={process.command} />
          <Detail label="Parent" value={process.parent_pid === null ? '—' : String(process.parent_pid)} />
          <Detail label="User" value={process.user ?? '—'} />
          <Detail label="Status" value={process.status} />
          <Detail label="CPU" value={formatCpu(process.cpu)} />
          <Detail
            label="Memory"
            value={`${formatBytes(process.memory)} (${formatMemoryPercent(process.memory, snapshot?.mem_total ?? 0)})`}
          />
          <Detail label="Virtual memory" value={formatBytes(process.virtual_memory)} />
          <Detail label="Elapsed" value={formatElapsed(process)} />
          <Detail label="Started" value={formatStarted(process)} />
        </VStack>
        <VStack gap={1}>
          <Text size="sm" color="secondary">
            Command line
          </Text>
          <pre className="whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/30 p-2 font-mono text-sm">
            {process.command}
          </pre>
        </VStack>
      </VStack>
    </ScrollableArea>
  );
}
