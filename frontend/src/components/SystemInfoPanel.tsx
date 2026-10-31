import { useEffect, useState } from 'react';
import type { SystemInfo, Theme, Usage } from '../generated/protocol';
import { Banner } from '@astryxdesign/core/Banner';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { useStore } from '../state/store';
import { CONFIG_DEFAULTS } from '../state/configDefaults';
import { collectClientInfo, type ClientInfo } from '../lib/clientInfo';

const LABEL = { position: 'start', width: 132 } as const;

/** A fastfetch-style report of the server host and this browser. */
export function SystemInfoPanel({ desktopVersion }: { desktopVersion: string | null }) {
  const [host, setHost] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const config = useStore((s) => s.config);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/system', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load system information (${response.status}).`);
        setHost(await response.json());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Could not load system information.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let current = true;
    collectClientInfo(desktopVersion).then((info) => current && setClient(info));
    return () => {
      current = false;
    };
  }, [desktopVersion]);

  const terminal = config?.terminal;
  return (
    <VStack gap={6} className="btm-mono select-text">
      {error ? (
        <Banner status="error" title={error} />
      ) : !host ? (
        <Text role="status">Collecting host information…</Text>
      ) : (
        <MetadataList title={<Title user={host.user} host={host.host_name} />} label={LABEL}>
          <Item label="OS" value={[host.os, host.arch].filter(Boolean).join(' ')} />
          <Item label="Host" value={host.model} />
          <Item label="Kernel" value={host.kernel} />
          <Item label="Uptime" value={duration(host.uptime)} />
          <Item label="Shell" value={host.shell} />
          {config && <Item label="Terminal" value={`btmux ${config.version}`} />}
          <Item
            label="Terminal font"
            value={`${terminal?.fontFamily ?? CONFIG_DEFAULTS.terminal.fontFamily} (${terminal?.fontSize ?? CONFIG_DEFAULTS.terminal.fontSize}px)`}
          />
          {config && <Item label="Theme" value={`${config.color_scheme} (${config.color_mode})`} />}
          {host.cpu && <Item label="CPU" value={cpu(host.cpu)} />}
          <UsageItem label="Memory" usage={host.memory} />
          {host.swap.total > 0 && <UsageItem label="Swap" usage={host.swap} />}
          {host.disks.map((disk) => (
            <UsageItem
              key={disk.mount}
              label={`Disk (${disk.mount})`}
              usage={disk.usage}
              suffix={[disk.file_system, disk.removable && 'external'].filter(Boolean).join(', ')}
            />
          ))}
          {host.addresses.length > 0 && (
            <MetadataListItem label={host.addresses.length > 1 ? 'Local IPs' : 'Local IP'}>
              <VStack gap={1}>
                {host.addresses.map((address) => (
                  <Text key={`${address.interface} ${address.address}`}>
                    {address.address}{' '}
                    <Text type="inherit" color="secondary">
                      ({address.interface})
                    </Text>
                  </Text>
                ))}
              </VStack>
            </MetadataListItem>
          )}
          {host.load && <Item label="Load" value={host.load.map((n) => n.toFixed(2)).join(', ')} />}
          <Item label="Processes" value={String(host.processes)} />
          <Item label="Locale" value={host.locale} />
        </MetadataList>
      )}
      {client ? (
        <MetadataList title={<Text type="large">This browser</Text>} label={LABEL}>
          <Item label="Browser" value={client.browser} />
          <Item label="OS" value={client.os} />
          <Item label="Display" value={client.display} />
          <Item label="GPU" value={client.gpu} />
          {client.threads && <Item label="CPU threads" value={String(client.threads)} />}
          <Item label="Locale" value={client.locale} />
          <Item label="Time zone" value={client.timeZone} />
          <Item label="Input" value={client.input} />
        </MetadataList>
      ) : (
        <Text role="status">Collecting browser information…</Text>
      )}
      {config && <Palette theme={config.theme} />}
    </VStack>
  );
}

function Title({ user, host }: { user: string | null; host: string | null }) {
  return (
    <Text type="large">
      <Text type="inherit" color="accent">
        {user ?? '?'}
      </Text>
      @
      <Text type="inherit" color="accent">
        {host ?? 'unknown'}
      </Text>
    </Text>
  );
}

function Item({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <MetadataListItem label={label}>
      <Text className="break-all">{value || 'Unavailable'}</Text>
    </MetadataListItem>
  );
}

function UsageItem({ label, usage, suffix }: { label: string; usage: Usage; suffix?: string }) {
  const percent = usage.total ? Math.round((usage.used / usage.total) * 100) : 0;
  return (
    <MetadataListItem label={label}>
      <VStack gap={1}>
        <Text>
          {bytes(usage.used)} / {bytes(usage.total)} ({percent}%){suffix ? ` – ${suffix}` : ''}
        </Text>
        <ProgressBar
          label={`${label} usage`}
          isLabelHidden
          value={percent}
          variant={percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'}
        />
      </VStack>
    </MetadataListItem>
  );
}

const ANSI: (keyof Theme)[][] = [
  ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'],
  [
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ],
];

function Palette({ theme }: { theme: Theme }) {
  return (
    <VStack gap={0} aria-label="Terminal palette" role="img">
      {ANSI.map((row) => (
        <HStack key={row[0]} gap={0}>
          {row.map((name) => (
            <span key={name} title={name} className="h-6 w-9" style={{ background: theme[name] }} />
          ))}
        </HStack>
      ))}
    </VStack>
  );
}

function cpu(cpu: NonNullable<SystemInfo['cpu']>): string {
  const ghz = cpu.mhz ? ` @ ${(cpu.mhz / 1000).toFixed(2)} GHz` : '';
  return `${cpu.brand} (${cpu.threads})${ghz}`;
}

function bytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}

function duration(seconds: number): string {
  const parts: [number, string][] = [
    [Math.floor(seconds / 86400), 'day'],
    [Math.floor((seconds % 86400) / 3600), 'hour'],
    [Math.floor((seconds % 3600) / 60), 'min'],
  ];
  const shown = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`);
  return shown.length ? shown.join(', ') : `${seconds} secs`;
}
