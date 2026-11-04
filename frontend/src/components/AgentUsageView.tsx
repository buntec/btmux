import { useEffect, useMemo, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import type { AgentTelemetry, AgentUsage, UsageBucket } from '../generated/protocol';
import {
  cumulativeUsage,
  formatCost,
  formatTokens,
  groupByModel,
  MODEL_COLORS,
  modelSlots,
  paneModelNames,
  USAGE_HISTORY_SECONDS,
  usageTimeline,
  usageTotal,
} from '../lib/agentUsage';
import { useStore } from '../state/store';

const TOTAL = 'var(--color-text-primary)';
const NEUTRAL = 'var(--color-text-secondary)';
const OTHER_DASH = '6 4';
const UNATTRIBUTED_DASH = '1 4';
const modelColor = (slot: number) => `var(--color-data-categorical-${MODEL_COLORS[slot]})`;
const timeLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const share = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

const RANGES = [
  { value: '15', label: '15 min', step: 1 },
  { value: '60', label: '1 hour', step: 1 },
  { value: '480', label: '8 hours', step: 5 },
  { value: '1440', label: '24 hours', step: 5 },
];

const tokensOf = (usage: AgentUsage) => usage.input_tokens + usage.output_tokens;

const TOKEN_TYPES: { value: string; label: string; metric: (usage: AgentUsage) => number }[] = [
  { value: 'total', label: 'Total', metric: tokensOf },
  { value: 'input', label: 'Input', metric: (usage) => usage.input_tokens },
  { value: 'output', label: 'Output', metric: (usage) => usage.output_tokens },
  { value: 'cached', label: 'Cached', metric: (usage) => usage.cached_tokens },
];

interface Line {
  label: string;
  color: string;
  dash?: string;
  values: number[];
}

function LineKey({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="14" height="12" aria-hidden="true" className="shrink-0">
      <line x1="1" x2="13" y1="6" y2="6" stroke={color} strokeWidth={2} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}

function UsageChart({
  title,
  timestamps,
  lines,
  money = false,
}: {
  title: string;
  timestamps: number[];
  lines: Line[];
  money?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const last = timestamps.length - 1;
  const max = Math.max(money ? 0.001 : 1, ...lines.map((line) => line.values[last]));
  const left = 54,
    right = 696,
    top = 14,
    bottom = 176;
  const x = (i: number) => left + (i / Math.max(1, last)) * (right - left);
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const format = (value: number) => (money ? formatCost(value) : formatTokens(value));
  const index = hover === null ? last : Math.min(hover, last);
  return (
    <VStack gap={3} className="min-w-0" data-agent-chart={title}>
      <Heading level={3}>{title}</Heading>
      <svg
        viewBox="0 0 720 210"
        role="img"
        aria-label={`${title}, running total`}
        tabIndex={0}
        className="w-full text-secondary"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setHover(Math.max(0, Math.min(last, index + (event.key === 'ArrowLeft' ? -1 : 1))));
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const position = ((event.clientX - rect.left) / rect.width) * 720;
          setHover(Math.max(0, Math.min(last, Math.round(((position - left) / (right - left)) * last))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <title>{title}</title>
        <desc>
          Running totals over the selected range.{' '}
          {lines.map((line) => `${line.label}: ${format(line.values[last])}`).join('. ')}.
        </desc>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1={left} x2={right} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--color-border)" />
            <text x={left - 8} y={y(max * fraction) + 4} textAnchor="end" fill="currentColor" fontSize={11}>
              {format(max * fraction)}
            </text>
          </g>
        ))}
        {lines.map((line) => (
          <polyline
            key={line.label}
            data-line={line.label}
            points={line.values.map((value, i) => `${x(i)},${y(value)}`).join(' ')}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeDasharray={line.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null && (
          <line x1={x(index)} x2={x(index)} y1={top} y2={bottom} stroke="var(--color-text-secondary)" />
        )}
        {[0, Math.floor(last / 2), last].map((i) => (
          <text key={i} x={x(i)} y={200} textAnchor="middle" fill="currentColor" fontSize={11}>
            {timeLabel(timestamps[i])}
          </text>
        ))}
      </svg>
      <HStack gap={3} wrap="wrap" vAlign="center">
        <Text type="supporting" color="secondary">
          {timeLabel(timestamps[index])}
        </Text>
        {lines.length === 0 && (
          <Text type="supporting" color="secondary">
            None in this range
          </Text>
        )}
        {lines.map((line) => (
          <HStack key={line.label} gap={1} vAlign="center" className="min-w-0">
            <LineKey color={line.color} dash={line.dash} />
            <Text type="supporting" className="btm-mono">
              {format(line.values[index])}
            </Text>
            <Text type="supporting" color="secondary" className="btm-mono">
              {line.label}
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
  const [tokenType, setTokenType] = useState('total');
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
        pane.models.some((model) =>
          model.buckets.some((bucket) => bucket.timestamp + 60 > now - USAGE_HISTORY_SECONDS),
        ),
      ),
    [telemetry, now],
  );
  const open = panes.filter((pane) => labels.has(pane.pane_id));
  const closed = panes.filter((pane) => !labels.has(pane.pane_id));
  const range = RANGES.find((item) => item.value === minutes) ?? RANGES[0];
  const selectedPane = open.find((pane) => pane.pane_id === selected);
  const timeline = (series: { buckets: UsageBucket[] }[]) =>
    usageTimeline(series, now, Number(range.value), range.step);
  const panesUsage = (items: AgentTelemetry[]) => usageTotal(timeline(items.flatMap((pane) => pane.models)));
  const shown = selectedPane ? [selectedPane] : panes;
  const total = panesUsage(shown);
  const closedUsage = panesUsage(closed);
  // From all usage, so filtering or changing the range doesn't repaint a model.
  const slots = modelSlots(Object.values(telemetry));
  const models = groupByModel(shown)
    .map((group) => {
      const running = cumulativeUsage(timeline(group.series));
      return { ...group, running, usage: running[running.length - 1].usage };
    })
    .filter(({ usage }) => tokensOf(usage) + usage.requests + usage.tool_calls + (usage.cost_usd ?? 0) > 0)
    .sort((a, b) => tokensOf(b.usage) - tokensOf(a.usage));
  const timestamps = timeline([]).map((bucket) => bucket.timestamp);
  const linesFor = (metric: (usage: AgentUsage) => number): Line[] => {
    const lines: Line[] = [];
    const sum = (into: number[] | null, values: number[]) =>
      into ? into.map((value, i) => value + values[i]) : values;
    let other: number[] | null = null;
    let unattributed: number[] | null = null;
    for (const model of models) {
      const values = model.running.map((bucket) => metric(bucket.usage));
      if (values[values.length - 1] === 0) continue;
      const slot = slots.get(model.key);
      if (model.model === null) unattributed = sum(unattributed, values);
      else if (slot === undefined) other = sum(other, values);
      else lines.push({ label: model.model, color: modelColor(slot), values });
    }
    if (other) lines.push({ label: 'Other', color: NEUTRAL, dash: OTHER_DASH, values: other });
    if (unattributed)
      lines.push({ label: 'Unattributed', color: NEUTRAL, dash: UNATTRIBUTED_DASH, values: unattributed });
    if (lines.length < 2) return lines;
    const all = lines.reduce<number[] | null>((into, line) => sum(into, line.values), null);
    // Drawn first, so a model holding most of the usage stays visible above it.
    return [{ label: 'Total', color: TOTAL, values: all ?? [] }, ...lines];
  };
  const tokenMetric = TOKEN_TYPES.find((type) => type.value === tokenType) ?? TOKEN_TYPES[0];
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
            Running total over {range.label} · {panes.length} {panes.length === 1 ? 'pane' : 'panes'}
          </Text>
        </VStack>
        {selectedPane && <Button label="All agents" variant="ghost" onClick={() => setSelected(null)} />}
        <SegmentedControl label="Token type" value={tokenType} onChange={setTokenType} size="sm">
          {TOKEN_TYPES.map((item) => (
            <SegmentedControlItem key={item.value} value={item.value} label={item.label} />
          ))}
        </SegmentedControl>
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
        <UsageChart title="Tokens" timestamps={timestamps} lines={linesFor(tokenMetric.metric)} />
        <UsageChart title="Completed requests" timestamps={timestamps} lines={linesFor((usage) => usage.requests)} />
        <UsageChart title="Tool calls" timestamps={timestamps} lines={linesFor((usage) => usage.tool_calls)} />
        {total.cost_usd !== null && (
          <UsageChart
            title="Reported cost"
            timestamps={timestamps}
            money
            lines={linesFor((usage) => usage.cost_usd ?? 0)}
          />
        )}
      </Grid>
      <Text type="supporting" color="secondary">
        Input includes cached tokens. Reasoning is included in output. Costs appear only when an agent reports them;
        mixed totals may be partial.
      </Text>
      <VStack gap={3}>
        <Heading level={3}>By model</Heading>
        <Table density="compact" aria-label="Agent usage by model">
          <TableHeader>
            <TableRow>
              {['Model', 'Tokens', 'Share', 'Cached input', 'Requests', 'Tool calls', 'Reported cost'].map((label) => (
                <TableHeaderCell key={label}>{label}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => {
              const slot = slots.get(model.key);
              const tokens = tokensOf(model.usage);
              const allTokens = tokensOf(total);
              return (
                <TableRow key={model.key} data-usage-model={model.model ?? 'unattributed'}>
                  <TableCell>
                    <HStack gap={2} vAlign="center">
                      <LineKey
                        color={slot === undefined ? NEUTRAL : modelColor(slot)}
                        dash={model.model === null ? UNATTRIBUTED_DASH : slot === undefined ? OTHER_DASH : undefined}
                      />
                      <VStack gap={1} className="min-w-0">
                        <Text className={model.model === null ? undefined : 'btm-mono'}>
                          {model.model ?? 'Unattributed'}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {model.agent}
                        </Text>
                      </VStack>
                    </HStack>
                  </TableCell>
                  <TableCell>{formatTokens(tokens)}</TableCell>
                  <TableCell>{tokens > 0 ? share.format(tokens / allTokens) : '–'}</TableCell>
                  <TableCell>{formatTokens(model.usage.cached_tokens)}</TableCell>
                  <TableCell>{formatTokens(model.usage.requests)}</TableCell>
                  <TableCell>{formatTokens(model.usage.tool_calls)}</TableCell>
                  <TableCell>{formatCost(model.usage.cost_usd)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Text type="supporting" color="secondary">
          Unattributed is usage reported without a model, such as Claude's tool calls.
        </Text>
      </VStack>
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
              const usage = panesUsage([pane]);
              return (
                <TableRow key={pane.pane_id}>
                  <TableCell>
                    <VStack gap={1}>
                      <Button
                        label={labels.get(pane.pane_id) ?? pane.pane_id}
                        variant="ghost"
                        onClick={() => setSelected(pane.pane_id)}
                      />
                      {paneModelNames(pane).map(({ agent, models: names }) => (
                        <Text key={agent} type="supporting" color="secondary" className="btm-mono">
                          {agent}
                          {names.length > 0 ? ` · ${names.join(', ')}` : ''}
                        </Text>
                      ))}
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
