import { useCallback, useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { Popover } from '@astryxdesign/core/Popover';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { InstanceStatus, Usage } from '../generated/protocol';
import { formatBytes } from '../lib/processFormat';
import { useStore } from '../state/store';

type Action = 'start' | 'stop' | 'restart' | 'delete';

const usage = (value: Usage | null) => value && `${formatBytes(value.used)} of ${formatBytes(value.total)}`;

const panesNote = (panes: number, verb: string) =>
  panes === 0
    ? ''
    : ` Its ${panes === 1 ? 'sandboxed pane offers' : `${panes} sandboxed panes offer`} to ${verb} it again.`;

/** The shared Multipass instance sandboxed sessions run in. */
export function MultipassButton() {
  const available = useStore((state) => !!state.config?.multipass);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<InstanceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  const refresh = useCallback(async (request?: Promise<Response>) => {
    try {
      const response = await (request ?? fetch('/api/multipass'));
      if (!response.ok) throw new Error((await response.text()) || response.statusText);
      setStatus((await response.json()) as InstanceStatus);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Polled only while open; `multipass info` takes a moment.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  if (!available) return null;

  const run = async (action: Action) => {
    setBusy(action);
    await refresh(fetch(`/api/multipass/${action}`, { method: 'POST' }));
    setBusy(null);
  };
  const confirm = (action: Action, title: string) => {
    setOpen(false);
    useStore.getState().setOverlay({ mode: 'confirm', title, onConfirm: () => void run(action) });
  };

  const state = status?.state ?? null;
  const running = state === 'Running';
  const name = status?.instance ?? 'the sandbox';
  const details = [
    status?.release && `Ubuntu ${status.release}`,
    status?.cpus && `${status.cpus} CPUs`,
    status?.memory && `memory ${usage(status.memory)}`,
    status?.disk && `disk ${usage(status.disk)}`,
  ].filter(Boolean);

  const content = (
    <VStack gap={2} className="btm-sans">
      <HStack gap={1} vAlign="center">
        {status && <StatusDot variant={running ? 'success' : 'neutral'} label={state ?? 'Not created'} />}
        <Text type="code" className="btm-mono">
          {name}
        </Text>
        <Text color="secondary">{status ? (state ?? 'not created').toLowerCase() : 'loading…'}</Text>
      </HStack>
      {details.length > 0 && <Text type="supporting">{details.join(' · ')}</Text>}
      {status && !state && <Text type="supporting">The next sandboxed pane creates it.</Text>}
      {error && (
        <HStack gap={1} vAlign="center">
          <StatusDot variant="error" label="Error" />
          <Text className="break-words">{error}</Text>
        </HStack>
      )}
      {status && state && (
        <HStack gap={1} wrap="wrap">
          {running ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                label="Restart"
                isLoading={busy === 'restart'}
                isDisabled={!!busy}
                onClick={() => void run('restart')}
              />
              <Button
                size="sm"
                variant="ghost"
                label="Stop"
                isLoading={busy === 'stop'}
                isDisabled={!!busy}
                onClick={() =>
                  status.panes > 0
                    ? confirm('stop', `Stop ${name}?${panesNote(status.panes, 'start')}`)
                    : void run('stop')
                }
              />
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              label="Start"
              isLoading={busy === 'start'}
              isDisabled={!!busy}
              onClick={() => void run('start')}
            />
          )}
          <Button
            size="sm"
            variant="destructive"
            label="Delete"
            isLoading={busy === 'delete'}
            isDisabled={!!busy}
            onClick={() =>
              confirm(
                'delete',
                `Delete and purge ${name}? Logins and anything installed in it are lost; the next sandboxed pane creates it again.${panesNote(status.panes, 'create')}`,
              )
            }
          />
        </HStack>
      )}
    </VStack>
  );

  return (
    <Popover
      label="Multipass sandbox"
      placement="above"
      alignment="end"
      width={360}
      isOpen={open}
      onOpenChange={setOpen}
      content={content}
    >
      <IconButton label="Multipass sandbox" tooltip="Multipass sandbox" variant="ghost" size="sm" icon={<Box />} />
    </Popover>
  );
}
