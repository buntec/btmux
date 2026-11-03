import type { AgentTelemetry, AgentUsage, UsageBucket } from '../generated/protocol';

export const emptyUsage = (): AgentUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  requests: 0,
  tool_calls: 0,
  duration_ms: 0,
  cost_usd: null,
});

export function addUsage(total: AgentUsage, usage: AgentUsage): AgentUsage {
  for (const key of Object.keys(total) as (keyof AgentUsage)[]) {
    if (key === 'cost_usd') {
      if (usage.cost_usd !== null) total.cost_usd = (total.cost_usd ?? 0) + usage.cost_usd;
    } else total[key] += usage[key];
  }
  return total;
}

/** Missing minutes are zero; cache and reasoning counts remain subsets. */
export function usageTimeline(panes: AgentTelemetry[], now: number, minutes: number): UsageBucket[] {
  const end = Math.floor(now / 60) * 60;
  const start = end - (minutes - 1) * 60;
  const buckets = Array.from({ length: minutes }, (_, i) => ({ timestamp: start + i * 60, usage: emptyUsage() }));
  for (const pane of panes) {
    for (const bucket of pane.buckets) {
      const index = Math.floor((bucket.timestamp - start) / 60);
      if (index >= 0 && index < buckets.length) addUsage(buckets[index].usage, bucket.usage);
    }
  }
  return buckets;
}

export const usageTotal = (buckets: UsageBucket[]) =>
  buckets.reduce((total, bucket) => addUsage(total, bucket.usage), emptyUsage());
export const formatTokens = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const formatCost = (value: number | null) =>
  value === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
