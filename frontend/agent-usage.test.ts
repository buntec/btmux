import { describe, expect, test } from 'bun:test';
import type { AgentTelemetry } from './src/generated/protocol';
import { cumulativeUsage, emptyUsage, mergeTelemetry, USAGE_HISTORY_SECONDS, usageTimeline, usageTotal } from './src/lib/agentUsage';

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
    expect(usageTotal(buckets).input_tokens).toBe(15);
    expect(buckets.every((bucket) => bucket.timestamp % 300 === 0)).toBe(true);
    expect(buckets[buckets.length - 1].timestamp).toBeLessThanOrEqual(now);
  });

  test('grouping keeps exactly the selected minutes at every offset into the current group', () => {
    for (const minutes of [480, 1440]) {
      for (let offset = 0; offset < 5; offset++) {
        const now = 600_030 + offset * 60;
        const lastMinute = Math.floor(now / 60) * 60;
        const firstMinute = lastMinute - (minutes - 1) * 60;
        const panes = [
          pane(firstMinute - 60, 1000, 0, 0, null),
          ...[0, 1, 2, 3, 4].map((i) => pane(firstMinute + i * 60, 1, 0, 0, null)),
          pane(lastMinute, 10, 0, 0, null),
          pane(lastMinute + 60, 1000, 0, 0, null),
        ];
        const fine = usageTimeline(panes, now, minutes, 1);
        const grouped = usageTimeline(panes, now, minutes, 5);
        expect(fine).toHaveLength(minutes);
        expect(usageTotal(fine).input_tokens).toBe(15);
        expect(usageTotal(grouped).input_tokens).toBe(15);
        // Only a range ending on a group's last minute fits in minutes / 5 groups.
        expect(grouped).toHaveLength(minutes / 5 + (offset === 4 ? 0 : 1));
        expect(grouped[grouped.length - 1].timestamp).toBe(Math.floor(lastMinute / 300) * 300);
      }
    }
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

  test('running totals never fall and end at the range total', () => {
    const minute = 6000;
    const buckets = usageTimeline(
      [pane(minute - 120, 50, 0, 5, null), pane(minute - 60, 0, 0, 0, 0.5), pane(minute, 10, 0, 1, 0.25)],
      minute + 30,
      15,
    );
    const running = cumulativeUsage(buckets);
    for (let i = 1; i < running.length; i++) {
      expect(running[i].usage.input_tokens).toBeGreaterThanOrEqual(running[i - 1].usage.input_tokens);
      expect(running[i].usage.cost_usd ?? 0).toBeGreaterThanOrEqual(running[i - 1].usage.cost_usd ?? 0);
    }
    expect(running[running.length - 1].usage).toEqual(usageTotal(buckets));
    // The per-step values are left alone.
    expect(buckets[buckets.length - 1].usage.input_tokens).toBe(10);
  });

  test('distinguishes a reported zero cost from unavailable cost', () => {
    expect(usageTotal(usageTimeline([pane(6000, 10, 0, 0, 0)], 6030, 15)).cost_usd).toBe(0);
  });
});
