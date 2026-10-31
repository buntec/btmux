import { useEffect, useState } from 'react';
import type { ServerInfo, UpdateStatus } from '../generated/protocol';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { useDesktopVersion } from '../hooks/useDesktopVersion';
import { desktopVersionMismatch } from '../lib/desktopApp';
import { Layout, LayoutContent, LayoutHeader, VStack } from '@astryxdesign/core/Layout';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { SystemInfoPanel } from './SystemInfoPanel';

type InfoTab = 'about' | 'system';

export function InfoDialog({ initialTab = 'about', onClose }: { initialTab?: InfoTab; onClose: () => void }) {
  const [tab, setTab] = useState<InfoTab>(initialTab);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const desktopVersion = useDesktopVersion();

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

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/update', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setUpdate(await response.json());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setUpdate({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);

  const rows: [string, string | null][] = info
    ? [
        ['Version', info.version],
        ...(desktopVersion ? [['Desktop app version', desktopVersion] as [string, string]] : []),
        ['Profile', info.profile ?? 'default'],
        ['Config file', info.config_file],
        ['State file', info.state_file],
        ['Token file', info.token_file],
        ['Log files', info.log_files ?? 'Disabled'],
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
          <DialogHeader title={<span className="btm-brand">btmux</span>} hasDivider={false} onOpenChange={changeOpen} />
        }
        content={
          <Layout
            header={
              <LayoutHeader paddingBlockEnd={0}>
                <TabList
                  value={tab}
                  onChange={(value) => setTab(value as InfoTab)}
                  role="tablist"
                  hasDivider
                  isFullBleed
                >
                  <Tab value="about" label="About" panelId="info-about" />
                  <Tab value="system" label="System" panelId="info-system" />
                </TabList>
              </LayoutHeader>
            }
            content={
              <LayoutContent padding={4}>
                {tab === 'system' ? (
                  <VStack id="info-system" role="tabpanel" aria-label="System">
                    <SystemInfoPanel desktopVersion={desktopVersion} />
                  </VStack>
                ) : (
                  <VStack id="info-about" role="tabpanel" aria-label="About">
                    {error ? (
                      <Banner status="error" title={error} />
                    ) : !info ? (
                      <Text role="status">Loading server information…</Text>
                    ) : (
                      <VStack gap={4}>
                        {desktopVersionMismatch(desktopVersion, info.version) && (
                          <Banner
                            status="warning"
                            title={`Version mismatch: app ${desktopVersion}, server ${info.version}`}
                          />
                        )}
                        {rows.map(([label, value]) => (
                          <VStack key={label} gap={1}>
                            <Text color="secondary">{label}</Text>
                            <Text type="code" className="break-all select-text">
                              {value ?? 'Unavailable'}
                            </Text>
                            {label === 'Version' && <UpdateLine update={update} />}
                          </VStack>
                        ))}
                      </VStack>
                    )}
                  </VStack>
                )}
              </LayoutContent>
            }
          />
        }
      />
    </Dialog>
  );
}

function UpdateLine({ update }: { update: UpdateStatus | null }) {
  if (!update) return <Text color="secondary">Checking for updates…</Text>;
  switch (update.state) {
    case 'disabled':
      return null;
    case 'current':
      return <Text color="secondary">Up to date (latest release: {update.latest})</Text>;
    case 'available':
      return (
        <Text>
          btmux {update.latest} is available.{' '}
          <Link href={update.url} isExternalLink>
            Release notes
          </Link>
        </Text>
      );
    case 'error':
      return <Text color="secondary">Could not check for updates: {update.message}</Text>;
  }
}
