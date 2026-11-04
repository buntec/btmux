/** Run with `bun browser-test-stack.ts agent-usage-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const post = async (path: string, data: unknown) => {
  const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  assert(response.ok, `${path}: ${response.status} ${await response.text()}`);
};
const create = async (name: string) => {
  const response = await fetch(`${url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  assert(response.ok);
  return (await response.json()).pane_id as string;
};
const codex = await create('usage-codex');
const claude = await create('usage-claude');
await post(`/api/panes/${codex}/agent-status`, { state: 'working', agent: 'codex' });
const attr = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'string' ? { stringValue: value } : { doubleValue: value },
});
const now = Math.floor(Date.now() / 60000) * 60;
const nanos = (seconds: number) => String(BigInt(seconds) * 1_000_000_000n);
const logs = Array.from({ length: 20 }, (_, i) => ({
  timeUnixNano: nanos(now - (19 - i) * 60),
  body: { stringValue: 'private test content' },
  attributes: [
    attr('event.name', 'codex.sse_event'),
    attr('event.kind', 'response.completed'),
    attr('model', 'codex-test'),
    attr('input_token_count', 1000 + (i % 5) * 500),
    attr('output_token_count', 100 + (i % 3) * 100),
    attr('cached_token_count', 500),
  ],
}));
const metrics = ['input', 'output', 'cacheRead'].map((kind, j) => ({
  name: 'claude_code.token.usage',
  sum: {
    isMonotonic: true,
    aggregationTemporality: 1,
    dataPoints: Array.from({ length: 20 }, (_, i) => ({
      startTimeUnixNano: nanos(now - (20 - i) * 60),
      timeUnixNano: nanos(now - (19 - i) * 60),
      asDouble: [800, 200, 500][j],
      attributes: [attr('type', kind), attr('model', 'claude-test')],
    })),
  },
}));
// The real endpoint, whose result depends on the machine's logins.
const realLimits = await fetch(`${url}/api/agent-limits`, { headers });
assert(realLimits.ok, `agent limits: ${realLimits.status}`);
assert(Array.isArray(await realLimits.json()));
assert.equal((await fetch(`${url}/api/agent-limits`)).status, 401);
const limitsNow = Date.now() / 1000;
let limitReads = 0;
let limitsReply: unknown[] = [
  {
    agent: 'Claude Code',
    plan: 'max',
    updated_at: limitsNow,
    limits: [
      { label: 'Current session', percent: 20, resets_at: limitsNow + 3600, severity: 'normal' },
      { label: 'Current week', percent: 85, resets_at: limitsNow + 5 * 86400, severity: 'warning' },
      { label: 'Current week (Fable)', percent: 100, resets_at: null, severity: 'critical' },
    ],
  },
  {
    agent: 'Codex',
    plan: 'prolite',
    updated_at: limitsNow - 600,
    limits: [{ label: 'Weekly', percent: 8, resets_at: limitsNow + 1800, severity: 'normal' }],
  },
];
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/api/agent-limits', (route) => {
  limitReads += 1;
  return route.fulfill({ json: limitsReply });
});
await context.addInitScript(() => {
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      const socket = new target(...(args as [string, string[]?]));
      if (socket.url.includes('/ws/control')) (window as any).__controlSocket = socket;
      return socket;
    },
  });
});
const errors: string[] = [];
const prepare = async (page: Page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/s/usage-codex`);
  if (await page.getByLabel('Access token').isVisible()) {
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().controlConnectionState === 'connected';
  });
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setAgentGridOpen(true);
  });
  await page.getByRole('tab', { name: 'Usage', exact: true }).click();
};

try {
  const page = await context.newPage();
  await prepare(page);
  // Chromium limits spread arguments; a full day across the pane limit must fit.
  const slots = await page.evaluate(async () => {
    const { emptyUsage, modelSlots } = await import('/src/lib/agentUsage.ts' as string);
    const telemetry = (model: string, timestamps: number[]) => ({
      models: [
        {
          agent: 'codex',
          model,
          totals: emptyUsage(),
          buckets: timestamps.map((timestamp) => ({ timestamp, usage: emptyUsage() })),
        },
      ],
    });
    const day = Array.from({ length: 1440 }, (_, i) => 6000 + i * 60);
    const panes = [...Array.from({ length: 128 }, () => telemetry('a', day)), telemetry('b', [5940])];
    return [...modelSlots(panes)];
  });
  assert.deepEqual(slots, [
    ['codex\0b', 0],
    ['codex\0a', 1],
  ]);
  await page.getByText('No usage received yet').waitFor();
  // Limits don't depend on telemetry, and rows keep their order and grade.
  await page.locator('[data-agent-limits]').waitFor();
  assert.deepEqual(
    await page
      .locator('[data-agent-limit]')
      .evaluateAll((rows) =>
        rows.map((row) => [row.getAttribute('data-agent-limit'), row.getAttribute('data-severity')]),
      ),
    [
      ['Current session', 'normal'],
      ['Current week', 'warning'],
      ['Current week (Fable)', 'critical'],
      ['Weekly', 'normal'],
    ],
  );
  const session = page.locator('[data-agent-limit="Current session"]');
  assert.match(await session.innerText(), /20% used/);
  assert.match(await session.innerText(), /Resets in (59m|1h 0m)/);
  assert.match(await page.locator('[data-agent-limit="Current week"]').innerText(), /Resets (?!in )/);
  assert.doesNotMatch(await page.locator('[data-agent-limit="Current week (Fable)"]').innerText(), /Resets/);
  assert.equal(await page.locator('[data-agent-limit-agent="Claude Code"] [data-agent-limit-stale]').count(), 0);
  assert.equal(await page.locator('[data-agent-limit-agent="Codex"] [data-agent-limit-stale]').count(), 1);
  assert.equal(limitReads, 1);
  // Without a subscription there is nothing to show, and only an open Usage tab polls.
  const saved = limitsReply;
  limitsReply = [];
  await page.getByRole('tab', { name: 'Live panes', exact: true }).click();
  await page.getByRole('tab', { name: 'Usage', exact: true }).click();
  await page.getByText('No usage received yet').waitFor();
  await waitForAsync(page, () => document.querySelector('[data-agent-limits]') === null);
  assert.equal(limitReads, 2);
  limitsReply = saved;
  await page.getByRole('tab', { name: 'Live panes', exact: true }).click();
  await page.getByRole('tab', { name: 'Usage', exact: true }).click();
  await page.locator('[data-agent-limits]').waitFor();
  await post(`/api/panes/${codex}/telemetry/v1/logs`, { resourceLogs: [{ scopeLogs: [{ logRecords: logs }] }] });
  await post(`/api/panes/${claude}/telemetry/v1/metrics`, { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] });
  await post(`/api/panes/${claude}/telemetry/v1/metrics`, {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.cost.usage',
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      startTimeUnixNano: nanos(now - 1200),
                      timeUnixNano: nanos(now),
                      asDouble: 0.25,
                      attributes: [attr('model', 'claude-test')],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  await page.getByRole('table', { name: 'Agent usage by pane' }).waitFor();
  await waitForAsync(page, () => document.querySelectorAll('[data-agent-chart]').length === 4);
  assert.equal(await page.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  assert.match((await page.locator('[data-usage-total="Reported cost"]').textContent()) ?? '', /0\.25/);
  // Re-exporting the same batch leaves totals unchanged.
  await post(`/api/panes/${codex}/telemetry/v1/logs`, { resourceLogs: [{ scopeLogs: [{ logRecords: logs }] }] });
  assert.equal(await page.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  await page.getByRole('button', { name: /usage-codex \/ / }).click();
  await page.getByRole('heading', { level: 2, name: /usage-codex/ }).waitFor();
  assert.equal(await page.locator('[data-usage-total="Reported cost"]').textContent(), 'Unavailable');
  await page.getByRole('button', { name: 'All agents', exact: true }).click();
  await page.getByRole('radio', { name: '15 min', exact: true }).click();
  assert.notEqual(await page.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  await page.getByRole('radio', { name: '1 hour', exact: true }).click();
  assert.equal(await page.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  await page.getByRole('radio', { name: '24 hours', exact: true }).click();
  assert.equal(await page.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  await page.getByRole('img', { name: 'Tokens, running total' }).waitFor();
  // Higher values are lower on the chart.
  const rising = await page.evaluate(() =>
    [...document.querySelectorAll<SVGPolylineElement>('[data-agent-chart] polyline')].map((line) => {
      const ys = line.getAttribute('points')!.split(' ').map((point) => Number(point.split(',')[1]));
      return {
        line: line.dataset.line,
        neverFalls: ys.every((y, i) => i === 0 || y <= ys[i - 1]),
        rises: ys[ys.length - 1] < ys[0],
      };
    }),
  );
  assert(rising.every((line) => line.neverFalls && line.rises), `charts must only rise: ${JSON.stringify(rising)}`);
  const linesOf = (chart: string, target = page) =>
    target
      .locator(`[data-agent-chart="${chart}"] polyline`)
      .evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).dataset.line));
  // Each model gets a line, with a total beside them.
  assert.deepEqual(await linesOf('Tokens'), ['Total', 'codex-test', 'claude-test']);
  assert.deepEqual(await linesOf('Completed requests'), ['codex-test']);
  assert.deepEqual(await linesOf('Tool calls'), []);
  assert.deepEqual(await linesOf('Reported cost'), ['claude-test']);
  // The token type changes only the tokens chart.
  await page.getByRole('radio', { name: 'Cached', exact: true }).click();
  const cachedEnd = await page.getByRole('img', { name: 'Tokens, running total' }).locator('desc').textContent();
  assert.match(cachedEnd ?? '', /codex-test: 10K/);
  await page.getByRole('radio', { name: 'Total', exact: true }).click();
  // Every model is listed, most tokens first, with its share.
  const rows = await page.getByRole('table', { name: 'Agent usage by model' }).locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /codex-test[\s\S]*59\.4%/);
  assert.match(rows[1], /claude-test[\s\S]*40\.6%/);
  // Filtering to a pane keeps a model's color.
  const stroke = (name: string) =>
    page.locator(`[data-agent-chart="Tokens"] polyline[data-line="${name}"]`).getAttribute('stroke');
  const codexColor = await stroke('codex-test');
  await page.getByRole('button', { name: /usage-codex \/ / }).click();
  await page.getByRole('heading', { level: 2, name: /usage-codex/ }).waitFor();
  assert.deepEqual(await linesOf('Tokens'), ['codex-test']);
  assert.equal(await stroke('codex-test'), codexColor);
  await page.getByRole('button', { name: 'All agents', exact: true }).click();
  if (process.env.BTMUX_TEST_SCREENSHOT)
    await page.screenshot({ path: process.env.BTMUX_TEST_SCREENSHOT, fullPage: true });
  const other = await context.newPage();
  await prepare(other);
  assert.equal(await other.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  await other.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().updateAgentTelemetry([], true);
    (window as any).__controlSocket.close();
  });
  await waitForAsync(other, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return (
      useStore.getState().controlConnectionState === 'connected' &&
      Object.keys(useStore.getState().agentTelemetry).length === 2
    );
  });
  assert.equal(await other.locator('[data-usage-total="Tokens"]').textContent(), '73.9K');
  assert(
    !(await other.evaluate(async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return JSON.stringify(useStore.getState().agentTelemetry).includes('private test content');
    })),
  );
  // A push holds only the changed minute; earlier minutes must survive it.
  await other.evaluate(() => {
    (window as any).__updates = [];
    (window as any).__controlSocket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      if (message.type === 'agent_telemetry') (window as any).__updates.push(message);
    });
  });
  const attributes = logs[19].attributes.filter((item) => item.key !== 'input_token_count');
  const logRecords = [{ ...logs[19], attributes: [...attributes, attr('input_token_count', 1100)] }];
  await post(`/api/panes/${codex}/telemetry/v1/logs`, { resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
  await waitForAsync(other, () => (window as any).__updates.length > 0);
  const update = await other.evaluate(() => (window as any).__updates[0]);
  assert.equal(update.replace, false);
  assert.equal(update.panes[0].models[0].buckets.length, 1);
  await waitForAsync(other, () => document.querySelector('[data-usage-total="Tokens"]')?.textContent !== '73.9K');
  const afterUpdate = await other.locator('[data-usage-total="Tokens"]').textContent();
  assert.equal(afterUpdate, '75.2K');
  // A closed pane's usage stays in the totals, in its own row.
  assert.equal(await other.locator('[data-usage-closed]').count(), 0);
  const killed = await fetch(`${url}/api/panes/${claude}`, { method: 'DELETE', headers });
  assert(killed.ok, `kill pane: ${killed.status}`);
  await other.locator('[data-usage-closed]').waitFor();
  assert.equal(await other.locator('[data-usage-total="Tokens"]').textContent(), afterUpdate);
  assert.equal(await other.getByRole('button', { name: /usage-claude \/ / }).count(), 0);
  await other.setViewportSize({ width: 390, height: 844 });
  await other.getByRole('img', { name: 'Tokens, running total' }).waitFor();
  assert(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await other.keyboard.press('Escape');
  await other.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(
    'Agent telemetry: live updates, retry handling, filtering, ranges, reconnect snapshots, and mobile layout passed.',
  );
} finally {
  await browser.close();
}
