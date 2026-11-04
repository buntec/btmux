import type { AgentTelemetry, AgentUsage, UsageBucket } from '../generated/protocol';

/** Mirrors `HISTORY_SECONDS` in `telemetry.rs`. */
export const USAGE_HISTORY_SECONDS = 24 * 3600;

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
export function usageTimeline(panes: AgentTelemetry[], now: number, minutes: number, stepMinutes = 1): UsageBucket[] {
  const step = stepMinutes * 60;
  const lastMinute = Math.floor(now / 60) * 60;
  const firstMinute = lastMinute - (minutes - 1) * 60;
  // Groups at either end may be partial, so the range can span one more than minutes / stepMinutes.
  const start = Math.floor(firstMinute / step) * step;
  const length = Math.floor((lastMinute - start) / step) + 1;
  const buckets = Array.from({ length }, (_, i) => ({ timestamp: start + i * step, usage: emptyUsage() }));
  for (const pane of panes) {
    for (const bucket of pane.buckets) {
      if (bucket.timestamp < firstMinute || bucket.timestamp > lastMinute) continue;
      addUsage(buckets[Math.floor((bucket.timestamp - start) / step)].usage, bucket.usage);
    }
  }
  return buckets;
}

/** Running totals: each bucket holds everything up to and including it. */
export function cumulativeUsage(buckets: UsageBucket[]): UsageBucket[] {
  let total = emptyUsage();
  return buckets.map((bucket) => {
    total = addUsage({ ...total }, bucket.usage);
    return { timestamp: bucket.timestamp, usage: total };
  });
}

/** Pushes hold only changed minutes, each with its whole value, so applying one twice is harmless. */
export function mergeTelemetry(current: AgentTelemetry | undefined, update: AgentTelemetry): AgentTelemetry {
  const buckets = new Map((current?.buckets ?? []).map((bucket) => [bucket.timestamp, bucket]));
  for (const bucket of update.buckets) buckets.set(bucket.timestamp, bucket);
  return {
    ...update,
    buckets: [...buckets.values()]
      .filter((bucket) => bucket.timestamp + 60 > update.updated_at - USAGE_HISTORY_SECONDS)
      .sort((a, b) => a.timestamp - b.timestamp),
  };
}

export const usageTotal = (buckets: UsageBucket[]) =>
  buckets.reduce((total, bucket) => addUsage(total, bucket.usage), emptyUsage());
export const formatTokens = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const formatCost = (value: number | null) =>
  value === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
