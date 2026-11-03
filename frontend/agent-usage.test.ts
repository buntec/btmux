import { describe, expect, test } from 'bun:test';
import type { AgentTelemetry } from './src/generated/protocol';
import { emptyUsage, usageTimeline, usageTotal } from './src/lib/agentUsage';

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

  test('distinguishes a reported zero cost from unavailable cost', () => {
    expect(usageTotal(usageTimeline([pane(6000, 10, 0, 0, 0)], 6030, 15)).cost_usd).toBe(0);
  });
});
