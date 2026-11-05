import { useEffect, useState } from 'react';
import type { HealthCheck, HealthReport, HealthStatus } from '../generated/protocol';
import { Banner } from '@astryxdesign/core/Banner';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { useStore } from '../state/store';
import { browserHealth } from '../lib/browserHealth';

const LABEL = { position: 'start', width: 152 } as const;

const DOT = {
  ok: { variant: 'success', label: 'OK' },
  missing: { variant: 'neutral', label: 'Not available' },
  warning: { variant: 'warning', label: 'Warning' },
  error: { variant: 'error', label: 'Error' },
} as const satisfies Record<HealthStatus, { variant: string; label: string }>;

/** Which optional programs the server found, and what this browser supports. */
export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<HealthCheck[] | null>(null);
  const osNotifications = useStore((s) => s.config?.notifications.os ?? true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not check the server (${response.status}).`);
        setReport(await response.json());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Could not check the server.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let current = true;
    browserHealth(osNotifications).then((checks) => current && setBrowser(checks));
    return () => {
      current = false;
    };
  }, [osNotifications]);

  const checks = [...(report?.groups.flatMap((group) => group.checks) ?? []), ...(browser ?? [])];
  return (
    <VStack gap={6} className="select-text">
      {error ? (
        <Banner status="error" title={error} />
      ) : !report ? (
        <Text role="status">Checking the server…</Text>
      ) : (
        browser && <Summary checks={checks} />
      )}
      {report?.groups.map((group) => (
        <Group key={group.title} title={group.title} checks={group.checks} />
      ))}
      {browser ? <Group title="This browser" checks={browser} /> : <Text role="status">Checking this browser…</Text>}
      {report && (
        <MetadataList title={<Text type="large">Search path</Text>} label={{ position: 'top' }}>
          <MetadataListItem label="btmux looks for programs on the server's PATH, which can differ from your shell's.">
            <VStack gap={1}>
              {report.path.map((dir, index) => (
                <Text key={`${index} ${dir}`} type="code" className="break-all">
                  {dir}
                </Text>
              ))}
            </VStack>
          </MetadataListItem>
        </MetadataList>
      )}
    </VStack>
  );
}

function Summary({ checks }: { checks: HealthCheck[] }) {
  const problems = checks.filter((check) => check.status === 'error' || check.status === 'warning');
  if (!problems.length) return <Banner status="success" title="No problems found" />;
  return (
    <Banner
      status={problems.some((check) => check.status === 'error') ? 'error' : 'warning'}
      title={`Needs attention: ${problems.map((check) => check.name).join(', ')}`}
    />
  );
}

function Group({ title, checks }: { title: string; checks: HealthCheck[] }) {
  return (
    <MetadataList title={<Text type="large">{title}</Text>} label={LABEL}>
      {checks.map((check) => (
        <MetadataListItem key={check.name} label={check.name}>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <StatusDot {...DOT[check.status]} />
              <Text type="code" className="break-all">
                {check.value}
              </Text>
            </HStack>
            {check.note && <Text>{check.note}</Text>}
            <Text color="secondary">{check.purpose}</Text>
            {check.path && (
              <Text type="code" color="secondary" className="break-all">
                {check.path}
              </Text>
            )}
          </VStack>
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}
