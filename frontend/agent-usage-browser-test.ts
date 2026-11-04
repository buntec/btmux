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
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  await page.getByText('No usage received yet').waitFor();
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
                  dataPoints: [{ startTimeUnixNano: nanos(now - 1200), timeUnixNano: nanos(now), asDouble: 0.25 }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  await page.getByRole('table', { name: 'Agent usage by pane' }).waitFor();
  await waitForAsync(page, () => document.querySelectorAll('[data-agent-chart]').length === 3);
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
  await page.getByRole('img', { name: 'Tokens, per 5 minutes' }).waitFor();
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
  assert.equal(update.panes[0].buckets.length, 1);
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
  await other.getByRole('img', { name: 'Tokens, per 5 minutes' }).waitFor();
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
