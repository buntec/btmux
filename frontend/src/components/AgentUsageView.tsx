import { useEffect, useMemo, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import type { AgentTelemetry, UsageBucket } from '../generated/protocol';
import { formatCost, formatTokens, USAGE_HISTORY_SECONDS, usageTimeline, usageTotal } from '../lib/agentUsage';
import { useStore } from '../state/store';

const INPUT = 'var(--color-data-categorical-blue)';
const OUTPUT = 'var(--color-data-categorical-green)';
const CACHE = 'var(--color-data-categorical-purple)';
const timeLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const RANGES = [
  { value: '15', label: '15 min', step: 1, unit: 'minute' },
  { value: '60', label: '1 hour', step: 1, unit: 'minute' },
  { value: '480', label: '8 hours', step: 5, unit: '5 minutes' },
  { value: '1440', label: '24 hours', step: 5, unit: '5 minutes' },
];

interface Series {
  label: string;
  color: string;
  value: (bucket: UsageBucket) => number;
}

function UsageChart({
  title,
  buckets,
  series,
  unit,
  money = false,
}: {
  title: string;
  buckets: UsageBucket[];
  series: Series[];
  unit: string;
  money?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(money ? 0.001 : 1, ...series.flatMap((s) => buckets.map(s.value)));
  const left = 54,
    right = 696,
    top = 14,
    bottom = 176;
  const x = (i: number) => left + (i / Math.max(1, buckets.length - 1)) * (right - left);
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const format = (value: number) => (money ? formatCost(value) : formatTokens(value));
  const index = hover === null ? buckets.length - 1 : Math.min(hover, buckets.length - 1);
  const active = buckets[index];
  return (
    <VStack gap={3} className="min-w-0" data-agent-chart={title}>
      <Heading level={3}>{title}</Heading>
      <svg
        viewBox="0 0 720 210"
        role="img"
        aria-label={`${title}, per ${unit}`}
        tabIndex={0}
        className="w-full text-secondary"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setHover(Math.max(0, Math.min(buckets.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))));
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const position = ((event.clientX - rect.left) / rect.width) * 720;
          setHover(
            Math.max(
              0,
              Math.min(buckets.length - 1, Math.round(((position - left) / (right - left)) * (buckets.length - 1))),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        <title>{title}</title>
        <desc>
          Values per {unit}.{' '}
          {series
            .map((s) => `${s.label}: ${format(buckets.reduce((sum, bucket) => sum + s.value(bucket), 0))}`)
            .join('. ')}
          .
        </desc>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1={left} x2={right} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--color-border)" />
            <text x={left - 8} y={y(max * fraction) + 4} textAnchor="end" fill="currentColor" fontSize={11}>
              {format(max * fraction)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <polyline
            key={s.label}
            points={buckets.map((bucket, i) => `${x(i)},${y(s.value(bucket))}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        {hover !== null && (
          <line
            x1={x(index)}
            x2={x(index)}
            y1={top}
            y2={bottom}
            stroke="var(--color-text-secondary)"
            strokeDasharray="3 3"
          />
        )}
        {[0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].map((i) => (
          <text key={i} x={x(i)} y={200} textAnchor="middle" fill="currentColor" fontSize={11}>
            {timeLabel(buckets[i].timestamp)}
          </text>
        ))}
      </svg>
      <HStack gap={3} wrap="wrap" vAlign="center">
        <Text type="supporting" color="secondary">
          {timeLabel(active.timestamp)}
        </Text>
        {series.map((s) => (
          <HStack key={s.label} gap={1} vAlign="center">
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="4" fill={s.color} />
            </svg>
            <Text type="supporting" className="btm-mono">
              {s.label}: {format(s.value(active))}
            </Text>
          </HStack>
        ))}
      </HStack>
    </VStack>
  );
}

export function AgentUsageView() {
  const telemetry = useStore((s) => s.agentTelemetry);
  const sessions = useStore((s) => s.allSessions);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [minutes, setMinutes] = useState('480');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 5000);
    return () => clearInterval(timer);
  }, []);
  const labels = useMemo(
    () =>
      new Map(
        sessions.flatMap((session) =>
          session.windows.flatMap((window) =>
            window.panes.map(
              (pane, i) => [pane.id, `${session.name} / ${window.name} / ${pane.title || `pane ${i + 1}`}`] as const,
            ),
          ),
        ),
      ),
    [sessions],
  );
  const panes = useMemo(
    () =>
      Object.values(telemetry).filter((pane) =>
        pane.buckets.some((bucket) => bucket.timestamp + 60 > now - USAGE_HISTORY_SECONDS),
      ),
    [telemetry, now],
  );
  const open = panes.filter((pane) => labels.has(pane.pane_id));
  const closed = panes.filter((pane) => !labels.has(pane.pane_id));
  const range = RANGES.find((item) => item.value === minutes) ?? RANGES[0];
  const timeline = (items: AgentTelemetry[]) => usageTimeline(items, now, Number(range.value), range.step);
  const selectedPane = open.find((pane) => pane.pane_id === selected);
  const buckets = timeline(selectedPane ? [selectedPane] : panes);
  const total = usageTotal(buckets);
  const closedUsage = usageTotal(timeline(closed));
  if (panes.length === 0)
    return (
      <VStack hAlign="center" vAlign="center" className="h-full">
        <EmptyState
          title="No usage received yet"
          description="Run btmux claude or btmux codex in a pane to see tokens, costs, and tool activity here."
        />
        <Text color="secondary">Usage history covers the last 24 hours and clears when the server restarts.</Text>
      </VStack>
    );
  return (
    <VStack gap={6} data-agent-usage>
      <HStack gap={3} wrap="wrap" vAlign="center">
        <VStack gap={1} className="min-w-0 flex-1">
          <Heading level={2}>{selectedPane ? labels.get(selectedPane.pane_id) : 'All agents'}</Heading>
          <Text color="secondary">
            Collected usage · per {range.unit} · {panes.length} {panes.length === 1 ? 'pane' : 'panes'}
          </Text>
        </VStack>
        {selectedPane && <Button label="All agents" variant="ghost" onClick={() => setSelected(null)} />}
        <SegmentedControl label="Usage time range" value={minutes} onChange={setMinutes} size="sm">
          {RANGES.map((item) => (
            <SegmentedControlItem key={item.value} value={item.value} label={item.label} />
          ))}
        </SegmentedControl>
      </HStack>
      <Grid columns={{ minWidth: 160, max: 4 }} gap={4}>
        {[
          ['Tokens', formatTokens(total.input_tokens + total.output_tokens)],
          ['Cached input', formatTokens(total.cached_tokens)],
          ['Completed requests', formatTokens(total.requests)],
          ['Reported cost', formatCost(total.cost_usd)],
        ].map(([label, value]) => (
          <VStack key={label} gap={1}>
            <Text color="secondary">{label}</Text>
            <Heading level={3} className="btm-mono" data-usage-total={label}>
              {value}
            </Heading>
          </VStack>
        ))}
      </Grid>
      <Grid columns={{ minWidth: 320, max: 2 }} gap={6}>
        <UsageChart
          title="Tokens"
          buckets={buckets}
          unit={range.unit}
          series={[
            { label: 'Input', color: INPUT, value: (b) => b.usage.input_tokens },
            { label: 'Output', color: OUTPUT, value: (b) => b.usage.output_tokens },
            { label: 'Cached', color: CACHE, value: (b) => b.usage.cached_tokens },
          ]}
        />
        <UsageChart
          title="Activity"
          buckets={buckets}
          unit={range.unit}
          series={[
            { label: 'Requests', color: INPUT, value: (b) => b.usage.requests },
            { label: 'Tool calls', color: OUTPUT, value: (b) => b.usage.tool_calls },
          ]}
        />
        {total.cost_usd !== null && (
          <UsageChart
            title="Reported cost"
            buckets={buckets}
            unit={range.unit}
            money
            series={[{ label: 'USD', color: CACHE, value: (b) => b.usage.cost_usd ?? 0 }]}
          />
        )}
      </Grid>
      <Text type="supporting" color="secondary">
        Input includes cached tokens. Reasoning is included in output. Costs appear only when an agent reports them;
        mixed totals may be partial.
      </Text>
      <VStack gap={3}>
        <Heading level={3}>By pane</Heading>
        <Table density="compact" aria-label="Agent usage by pane">
          <TableHeader>
            <TableRow>
              {['Agent / pane', 'Tokens', 'Requests', 'Tool calls', 'Reported cost', 'Last received'].map((label) => (
                <TableHeaderCell key={label}>{label}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {open.map((pane) => {
              const usage = usageTotal(timeline([pane]));
              return (
                <TableRow key={pane.pane_id}>
                  <TableCell>
                    <VStack gap={1}>
                      <Button
                        label={labels.get(pane.pane_id) ?? pane.agent}
                        variant="ghost"
                        onClick={() => setSelected(pane.pane_id)}
                      />
                      <Text type="supporting" color="secondary">
                        {pane.agent}
                        {pane.model ? ` · ${pane.model}` : ''}
                      </Text>
                    </VStack>
                  </TableCell>
                  <TableCell>{formatTokens(usage.input_tokens + usage.output_tokens)}</TableCell>
                  <TableCell>{formatTokens(usage.requests)}</TableCell>
                  <TableCell>{formatTokens(usage.tool_calls)}</TableCell>
                  <TableCell>{formatCost(usage.cost_usd)}</TableCell>
                  <TableCell>{timeLabel(pane.updated_at)}</TableCell>
                </TableRow>
              );
            })}
            {closed.length > 0 && (
              <TableRow data-usage-closed>
                <TableCell>
                  <VStack gap={1}>
                    <Text>Closed panes</Text>
                    <Text type="supporting" color="secondary">
                      {closed.length} {closed.length === 1 ? 'pane' : 'panes'}
                    </Text>
                  </VStack>
                </TableCell>
                <TableCell>{formatTokens(closedUsage.input_tokens + closedUsage.output_tokens)}</TableCell>
                <TableCell>{formatTokens(closedUsage.requests)}</TableCell>
                <TableCell>{formatTokens(closedUsage.tool_calls)}</TableCell>
                <TableCell>{formatCost(closedUsage.cost_usd)}</TableCell>
                <TableCell>{timeLabel(Math.max(...closed.map((pane) => pane.updated_at)))}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </VStack>
      <Text type="supporting" color="secondary">
        History covers 24 hours, including closed panes. Upgrades keep it; restarting the server clears it.
      </Text>
    </VStack>
  );
}
