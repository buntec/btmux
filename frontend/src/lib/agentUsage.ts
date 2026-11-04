import type { AgentTelemetry, AgentUsage, ModelTelemetry, UsageBucket } from '../generated/protocol';

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

type Series = { buckets: UsageBucket[] };

/** Sums `series` per step. Missing minutes are zero; cache and reasoning counts remain subsets. */
export function usageTimeline(series: Series[], now: number, minutes: number, stepMinutes = 1): UsageBucket[] {
  const step = stepMinutes * 60;
  const lastMinute = Math.floor(now / 60) * 60;
  const firstMinute = lastMinute - (minutes - 1) * 60;
  // Groups at either end may be partial, so the range can span one more than minutes / stepMinutes.
  const start = Math.floor(firstMinute / step) * step;
  const length = Math.floor((lastMinute - start) / step) + 1;
  const buckets = Array.from({ length }, (_, i) => ({ timestamp: start + i * step, usage: emptyUsage() }));
  for (const { buckets: source } of series) {
    for (const bucket of source) {
      if (bucket.timestamp < firstMinute || bucket.timestamp > lastMinute) continue;
      addUsage(buckets[Math.floor((bucket.timestamp - start) / step)].usage, bucket.usage);
    }
  }
  return buckets;
}

export const modelKey = (model: { agent: string; model: string | null }) => `${model.agent}\0${model.model ?? ''}`;

export interface ModelGroup {
  key: string;
  agent: string;
  model: string | null;
  series: ModelTelemetry[];
}

/** Each agent's model across `panes`. */
export function groupByModel(panes: AgentTelemetry[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const pane of panes) {
    for (const series of pane.models) {
      const key = modelKey(series);
      const group = groups.get(key) ?? { key, agent: series.agent, model: series.model, series: [] };
      group.series.push(series);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

/** Chart colors, as `--color-data-categorical-*` names, in their validated order. */
export const MODEL_COLORS = ['blue', 'green', 'purple', 'cyan', 'orange'];

/**
 * Each model's color slot, in order of first use, so filtering or a new leader
 * doesn't repaint a model. Models past the last slot and usage without a model
 * have none: charts show those as neutral "Other" and "Unattributed" lines.
 */
export function modelSlots(panes: AgentTelemetry[]): Map<string, number> {
  const firstUse = (group: ModelGroup) => {
    let first = Infinity;
    for (const series of group.series) {
      for (const bucket of series.buckets) first = Math.min(first, bucket.timestamp);
    }
    return first;
  };
  const named = groupByModel(panes)
    .filter((group) => group.model !== null)
    .map((group) => ({ key: group.key, first: firstUse(group) }))
    .sort((a, b) => a.first - b.first || a.key.localeCompare(b.key));
  return new Map(named.slice(0, MODEL_COLORS.length).map((group, slot) => [group.key, slot]));
}

/** Running totals: each bucket holds everything up to and including it. */
export function cumulativeUsage(buckets: UsageBucket[]): UsageBucket[] {
  let total = emptyUsage();
  return buckets.map((bucket) => {
    total = addUsage({ ...total }, bucket.usage);
    return { timestamp: bucket.timestamp, usage: total };
  });
}

/**
 * Pushes hold only changed minutes, each with its whole value, and only the
 * models they changed, so applying one twice is harmless.
 */
export function mergeTelemetry(current: AgentTelemetry | undefined, update: AgentTelemetry): AgentTelemetry {
  const models = new Map((current?.models ?? []).map((model) => [modelKey(model), model]));
  for (const model of update.models) {
    const buckets = new Map((models.get(modelKey(model))?.buckets ?? []).map((bucket) => [bucket.timestamp, bucket]));
    for (const bucket of model.buckets) buckets.set(bucket.timestamp, bucket);
    models.set(modelKey(model), { ...model, buckets: [...buckets.values()] });
  }
  return {
    ...update,
    models: [...models.values()]
      .map((model) => ({
        ...model,
        buckets: model.buckets
          .filter((bucket) => bucket.timestamp + 60 > update.updated_at - USAGE_HISTORY_SECONDS)
          .sort((a, b) => a.timestamp - b.timestamp),
      }))
      .filter((model) => model.buckets.length > 0),
  };
}

/** Per agent, its named models with the most tokens first. */
export function paneModelNames(pane: AgentTelemetry): { agent: string; models: string[] }[] {
  const tokens = (model: ModelTelemetry) => {
    const total = usageTotal(model.buckets);
    return total.input_tokens + total.output_tokens;
  };
  const agents = new Map<string, string[]>();
  for (const model of [...pane.models].sort((a, b) => tokens(b) - tokens(a))) {
    const names = agents.get(model.agent) ?? [];
    if (model.model !== null) names.push(model.model);
    agents.set(model.agent, names);
  }
  return [...agents].map(([agent, models]) => ({ agent, models }));
}

export const usageTotal = (buckets: UsageBucket[]) =>
  buckets.reduce((total, bucket) => addUsage(total, bucket.usage), emptyUsage());
export const formatTokens = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const formatCost = (value: number | null) =>
  value === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
