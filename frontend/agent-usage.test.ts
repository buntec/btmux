import { describe, expect, test } from 'bun:test';
import type { AgentTelemetry, ModelTelemetry } from './src/generated/protocol';
import {
  cumulativeUsage,
  emptyUsage,
  formatLimitPercent,
  formatLimitReset,
  groupByModel,
  limitsAreStale,
  mergeTelemetry,
  MODEL_COLORS,
  modelKey,
  modelSlots,
  paneModelNames,
  USAGE_HISTORY_SECONDS,
  usageTimeline,
  usageTotal,
} from './src/lib/agentUsage';
import { chartColor, contrastRatio } from './src/lib/astryx-theme';

const series = (
  model: string | null,
  timestamp: number,
  input: number,
  cached = 0,
  output = 0,
  cost: number | null = null,
  agent = 'codex',
): ModelTelemetry => ({
  agent,
  model,
  totals: emptyUsage(),
  buckets: [
    {
      timestamp,
      usage: { ...emptyUsage(), input_tokens: input, cached_tokens: cached, output_tokens: output, cost_usd: cost },
    },
  ],
});

const pane = (timestamp: number, ...models: ModelTelemetry[]): AgentTelemetry => ({
  pane_id: 'pane',
  updated_at: timestamp,
  totals: emptyUsage(),
  models,
});

const pointsOf = (...panes: AgentTelemetry[]) => panes.flatMap((item) => item.models);

describe('agent usage timelines', () => {
  test('adds matching minutes across models without adding cached tokens twice', () => {
    const buckets = usageTimeline(
      [series('a', 6000, 1000, 800, 100), series('b', 6000, 500, 200, 50, 0.01)],
      6030,
      15,
    );
    expect(buckets).toHaveLength(15);
    const total = usageTotal(buckets);
    expect(total.input_tokens + total.output_tokens).toBe(1650);
    expect(total.cached_tokens).toBe(1000);
    expect(total.cost_usd).toBe(0.01);
    expect(buckets.slice(0, -1).every((bucket) => bucket.usage.input_tokens === 0)).toBe(true);
  });

  test('ages history and excludes future minutes', () => {
    const buckets = usageTimeline([series('a', 5100, 100), series('a', 6060, 100)], 6030, 15);
    expect(usageTotal(buckets).input_tokens).toBe(0);
    expect(usageTotal(buckets).cost_usd).toBeNull();
  });

  test('groups minutes into longer steps without losing usage', () => {
    const now = 600_030;
    const minute = Math.floor(now / 60) * 60;
    const buckets = usageTimeline([series('a', minute, 10), series('a', minute - 60, 5)], now, 1440, 5);
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
        const points = [
          series('a', firstMinute - 60, 1000),
          ...[0, 1, 2, 3, 4].map((i) => series('a', firstMinute + i * 60, 1)),
          series('a', lastMinute, 10),
          series('a', lastMinute + 60, 1000),
        ];
        const fine = usageTimeline(points, now, minutes, 1);
        const grouped = usageTimeline(points, now, minutes, 5);
        expect(fine).toHaveLength(minutes);
        expect(usageTotal(fine).input_tokens).toBe(15);
        expect(usageTotal(grouped).input_tokens).toBe(15);
        // Only a range ending on a group's last minute fits in minutes / 5 groups.
        expect(grouped).toHaveLength(minutes / 5 + (offset === 4 ? 0 : 1));
        expect(grouped[grouped.length - 1].timestamp).toBe(Math.floor(lastMinute / 300) * 300);
      }
    }
  });

  test('merges changed minutes per model, replacing values and keeping the rest', () => {
    const first = mergeTelemetry(undefined, pane(6000, series('a', 6000, 10)));
    const second = mergeTelemetry(first, pane(6060, series('a', 6060, 20)));
    const third = mergeTelemetry(second, pane(6060, series('a', 6060, 25)));
    expect(third.models[0].buckets.map((bucket) => bucket.timestamp)).toEqual([6000, 6060]);
    expect(usageTotal(third.models[0].buckets).input_tokens).toBe(35);
    // A repeated push changes nothing.
    expect(mergeTelemetry(third, pane(6060, series('a', 6060, 25)))).toEqual(third);
    // A push for one model keeps the others.
    const fourth = mergeTelemetry(third, pane(6120, series('b', 6120, 5)));
    expect(fourth.models.map((model) => model.model)).toEqual(['a', 'b']);
    expect(usageTotal(pointsOf(fourth).flatMap((model) => model.buckets)).input_tokens).toBe(40);
  });

  test('merging keeps the same model name of different agents apart', () => {
    const merged = mergeTelemetry(
      pane(6000, series('m', 6000, 1, 0, 0, null, 'codex')),
      pane(6000, series('m', 6000, 2, 0, 0, null, 'claude')),
    );
    expect(merged.models.map((model) => model.agent)).toEqual(['codex', 'claude']);
  });

  test('merging drops minutes and models older than the retained history', () => {
    const old = mergeTelemetry(undefined, pane(6000, series('a', 6000, 10)));
    const later = 6000 + USAGE_HISTORY_SECONDS + 60;
    const merged = mergeTelemetry(old, pane(later, series('b', later, 20)));
    expect(merged.models.map((model) => model.model)).toEqual(['b']);
  });

  test('running totals never fall and end at the range total', () => {
    const minute = 6000;
    const buckets = usageTimeline(
      [series('a', minute - 120, 50, 0, 5), series('a', minute - 60, 0, 0, 0, 0.5), series('a', minute, 10, 0, 1, 0.25)],
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
    expect(usageTotal(usageTimeline([series('a', 6000, 10, 0, 0, 0)], 6030, 15)).cost_usd).toBe(0);
  });
});

describe('model groups and colors', () => {
  test('groups a model across panes', () => {
    const groups = groupByModel([pane(6000, series('a', 6000, 1)), pane(6000, series('a', 6060, 2), series('b', 6000, 3))]);
    expect(groups.map((group) => [group.model, group.series.length])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  test('colors follow first use, not rank, and never cycle', () => {
    const names = ['f', 'e', 'd', 'c', 'b', 'a'];
    const slots = modelSlots([pane(6000, ...names.map((name, i) => series(name, 6000 + i * 60, 1000 - i)))]);
    expect(slots.size).toBe(MODEL_COLORS.length);
    expect(slots.get(modelKey({ agent: 'codex', model: 'f' }))).toBe(0);
    expect(slots.get(modelKey({ agent: 'codex', model: 'b' }))).toBe(4);
    expect(slots.has(modelKey({ agent: 'codex', model: 'a' }))).toBe(false);
    // A later, bigger model doesn't repaint an earlier one.
    const grown = modelSlots([pane(6000, series('f', 6000, 1), series('e', 6060, 1e9))]);
    expect(grown.get(modelKey({ agent: 'codex', model: 'f' }))).toBe(0);
  });

  test('usage without a model takes no color slot', () => {
    const slots = modelSlots([pane(6000, series(null, 5940, 1), series('a', 6000, 1))]);
    expect(slots.get(modelKey({ agent: 'codex', model: 'a' }))).toBe(0);
    expect(slots.size).toBe(1);
  });
});

describe('pane model names', () => {
  test('lists every named model per agent, most tokens first', () => {
    const names = paneModelNames(
      pane(
        6000,
        series('helper', 6000, 10),
        series('main', 6000, 1000),
        series(null, 6000, 0, 0, 0, null, 'claude'),
        series('opus', 6000, 5, 0, 0, null, 'claude'),
      ),
    );
    expect(names).toEqual([
      { agent: 'codex', models: ['main', 'helper'] },
      { agent: 'claude', models: ['opus'] },
    ]);
  });
});

describe('chart colors', () => {
  test('stay readable on the background', () => {
    for (const background of ['#14110b', '#fcf8ee', '#000000', '#ffffff']) {
      for (const color of ['#84b5eb', '#cbaf53', '#59c6bc', '#808080']) {
        expect(contrastRatio(chartColor(color, background, 0.5), background)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('plan limits', () => {
  const now = 1_000_000;
  test('reset times are relative within a day', () => {
    expect(formatLimitReset(now - 1, now)).toBe('Resetting');
    expect(formatLimitReset(now, now)).toBe('Resetting');
    expect(formatLimitReset(now + 1, now)).toBe('Resets in 1m');
    expect(formatLimitReset(now + 59 * 60, now)).toBe('Resets in 59m');
    expect(formatLimitReset(now + 60 * 60, now)).toBe('Resets in 1h 0m');
    expect(formatLimitReset(now + 5 * 3600 + 3 * 60, now)).toBe('Resets in 5h 3m');
    expect(formatLimitReset(now + 24 * 3600, now)).toMatch(/^Resets \p{L}+/u);
    expect(formatLimitReset(now + 24 * 3600, now)).not.toContain(' in ');
  });
  test('percentages and staleness', () => {
    expect(formatLimitPercent(11.4)).toBe('11% used');
    expect(limitsAreStale(now - 180, now)).toBe(false);
    expect(limitsAreStale(now - 181, now)).toBe(true);
  });
});
