import { useEffect, useState } from 'react';
import type { ServerInfo } from '../generated/protocol';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Text } from '@astryxdesign/core/Text';
import { Layout, LayoutContent, VStack } from '@astryxdesign/core/Layout';

export function InfoDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/info', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load server information (${response.status}).`);
        setInfo(await response.json());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Could not load server information.');
      });
    return () => controller.abort();
  }, []);

  const rows: [string, string | null][] = info
    ? [
        ['Version', info.version],
        ['Profile', info.profile ?? 'default'],
        ['Config file', info.config_file],
        ['State file', info.state_file],
        ['Token file', info.token_file],
        ['Credential source', info.token_source],
        ['Listening address', info.listen_address],
        ['Executable', info.executable],
      ]
    : [];

  const changeOpen = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <Dialog isOpen onOpenChange={changeOpen} maxHeight="85dvh" width={640}>
      <Layout
        header={
          <DialogHeader
            title="About btmux"
            subtitle="Server version and runtime configuration."
            onOpenChange={changeOpen}
          />
        }
        content={
          <LayoutContent padding={4}>
            {error ? (
              <Banner status="error" title={error} />
            ) : !info ? (
              <Text role="status">Loading server information…</Text>
            ) : (
              <VStack gap={4}>
                {rows.map(([label, value]) => (
                  <VStack key={label} gap={1}>
                    <Text color="secondary">{label}</Text>
                    <Text type="code" className="break-all select-text">
                      {value ?? 'Unavailable'}
                    </Text>
                  </VStack>
                ))}
              </VStack>
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
