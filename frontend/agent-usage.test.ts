import { describe, expect, test } from 'bun:test';
import type { AgentTelemetry } from './src/generated/protocol';
import { emptyUsage, mergeTelemetry, USAGE_HISTORY_SECONDS, usageTimeline, usageTotal } from './src/lib/agentUsage';

const pane = (
  timestamp: number,
  input: number,
  cached: number,
  output: number,
  cost: number | null,
): AgentTelemetry => ({
  pane_id: 'pane',
  agent: 'codex',
  model: null,
  updated_at: timestamp,
  totals: emptyUsage(),
  buckets: [
    {
      timestamp,
      usage: { ...emptyUsage(), input_tokens: input, cached_tokens: cached, output_tokens: output, cost_usd: cost },
    },
  ],
});

describe('agent usage timelines', () => {
  test('adds matching minutes across panes without adding cached tokens twice', () => {
    const buckets = usageTimeline([pane(6000, 1000, 800, 100, null), pane(6000, 500, 200, 50, 0.01)], 6030, 15);
    expect(buckets).toHaveLength(15);
    const total = usageTotal(buckets);
    expect(total.input_tokens + total.output_tokens).toBe(1650);
    expect(total.cached_tokens).toBe(1000);
    expect(total.cost_usd).toBe(0.01);
    expect(buckets.slice(0, -1).every((bucket) => bucket.usage.input_tokens === 0)).toBe(true);
  });

  test('ages history and excludes future minutes', () => {
    const buckets = usageTimeline([pane(5100, 100, 0, 0, null), pane(6060, 100, 0, 0, null)], 6030, 15);
    expect(usageTotal(buckets).input_tokens).toBe(0);
    expect(usageTotal(buckets).cost_usd).toBeNull();
  });

  test('groups minutes into longer steps without losing usage', () => {
    const now = 600_030;
    const minute = Math.floor(now / 60) * 60;
    const buckets = usageTimeline([pane(minute, 10, 0, 0, null), pane(minute - 60, 5, 0, 0, null)], now, 1440, 5);
    expect(buckets).toHaveLength(288);
    expect(usageTotal(buckets).input_tokens).toBe(15);
    expect(buckets.every((bucket) => bucket.timestamp % 300 === 0)).toBe(true);
    expect(buckets[buckets.length - 1].timestamp).toBeLessThanOrEqual(now);
  });

  test('merges changed minutes, replacing values and keeping the rest', () => {
    const first = mergeTelemetry(undefined, pane(6000, 10, 0, 0, null));
    const second = mergeTelemetry(first, pane(6060, 20, 0, 0, null));
    const third = mergeTelemetry(second, pane(6060, 25, 0, 0, null));
    expect(third.buckets.map((bucket) => bucket.timestamp)).toEqual([6000, 6060]);
    expect(usageTotal(third.buckets).input_tokens).toBe(35);
    // A repeated push changes nothing.
    expect(mergeTelemetry(third, pane(6060, 25, 0, 0, null))).toEqual(third);
  });

  test('merging drops minutes older than the retained history', () => {
    const old = mergeTelemetry(undefined, pane(6000, 10, 0, 0, null));
    const later = 6000 + USAGE_HISTORY_SECONDS + 60;
    const merged = mergeTelemetry(old, pane(later, 20, 0, 0, null));
    expect(merged.buckets.map((bucket) => bucket.timestamp)).toEqual([later]);
  });

  test('distinguishes a reported zero cost from unavailable cost', () => {
    expect(usageTotal(usageTimeline([pane(6000, 10, 0, 0, 0)], 6030, 15)).cost_usd).toBe(0);
  });
});
