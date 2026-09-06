/** Run against an isolated dev stack: BTMUX_AUTH_TOKEN=... bun reliability-test.ts */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}${path}`, {
    headers,
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
};
assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
assert.equal(
  (await fetch(`${url}/api/sessions`, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status,
  403,
);
const session = await api('/api/sessions', { name: `reliability-${Date.now()}` });
const snapshot = await api(`/api/sessions/${session.id}`);
const pane = snapshot.windows[0].panes[0].id;
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).testSockets = [];
    (window as any).testMessages = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).testSockets.push(this);
        this.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            try {
              (window as any).testMessages.push(JSON.parse(event.data));
            } catch {}
          }
        });
      }
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#access-token'));
  await page.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await page.waitForFunction(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const term = useStore.getState().terminals.get(id);
    return term && (window as any).testMessages.some((m: any) => m.type === 'ready' && m.pane_id === id);
  }, pane);
  await api(`/api/panes/${pane}/input`, { text: "printf '\\nREPLAY_🙂_OK\\n'\r" });
  const readTerminal = async () =>
    page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      const buf = term.buffer.active;
      return Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join('\n');
    }, pane);
  await page.waitForFunction(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const buf = useStore.getState().terminals.get(id).buffer.active;
    return Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '')
      .join('\n')
      .includes('\nREPLAY_🙂_OK\n');
  }, pane);
  await page.waitForTimeout(250);
  const before = await readTerminal();
  const oldCount = await page.evaluate(
    (id) => (window as any).testSockets.filter((s: WebSocket) => s.url.includes(`/ws/pane/${id}`)).length,
    pane,
  );
  await page.evaluate(
    (id) => (window as any).testSockets.findLast((s: WebSocket) => s.url.includes(`/ws/pane/${id}`)).close(),
    pane,
  );
  await page.waitForFunction(
    ({ id, count }) =>
      (window as any).testSockets.filter((s: WebSocket) => s.url.includes(`/ws/pane/${id}`) && s.readyState === 1)
        .length > 0 &&
      (window as any).testSockets.filter((s: WebSocket) => s.url.includes(`/ws/pane/${id}`)).length > count,
    { id: pane, count: oldCount },
  );
  await page.waitForTimeout(250);
  assert.equal(await readTerminal(), before, 'reconnect must preserve output without duplication');
  console.log('PASS authentication, origin rejection, pane reconnect and replay');

  // An unrelated configuration change must keep the exact emulator instance.
  await page.evaluate(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    (window as any).testTerminal = useStore.getState().terminals.get(id);
    (window as any).testSockets
      .findLast((s: WebSocket) => s.url.endsWith('/ws/control'))
      .send(JSON.stringify({ type: 'update_config', update: { animations: true }, request_id: 'config-test' }));
  }, pane);
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().config.animations;
  });
  assert(
    await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().terminals.get(id) === (window as any).testTerminal;
    }, pane),
  );
  console.log('PASS configuration updates retain terminal instances');
  await page.evaluate(() => {
    (window as any).testSockets
      .findLast((s: WebSocket) => s.url.endsWith('/ws/control'))
      .send(
        JSON.stringify({
          type: 'kill_session',
          id: '00000000-0000-0000-0000-000000000000',
          request_id: 'missing-session',
        }),
      );
  });
  await page.waitForFunction(() =>
    (window as any).testMessages.some(
      (m: any) => m.type === 'command_result' && m.request_id === 'missing-session' && m.error,
    ),
  );
  const controlCount = await page.evaluate(
    () => (window as any).testSockets.filter((s: WebSocket) => s.url.endsWith('/ws/control')).length,
  );
  await page.evaluate(() =>
    (window as any).testSockets.findLast((s: WebSocket) => s.url.endsWith('/ws/control')).close(),
  );
  await page.waitForFunction(async (count) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return (
      useStore.getState().controlConnected &&
      (window as any).testSockets.filter((s: WebSocket) => s.url.endsWith('/ws/control')).length > count
    );
  }, controlCount);
  console.log('PASS correlated command errors and control reconnect');

  const second = await context.newPage();
  await second.setViewportSize({ width: 800, height: 600 });
  const ownerSize = await page.evaluate(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const term = useStore.getState().terminals.get(id);
    return [term.cols, term.rows];
  }, pane);
  await second.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await second.waitForFunction(
    async ({ id, size }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      return term && term.cols === size[0] && term.rows === size[1];
    },
    { id: pane, size: ownerSize },
  );
  assert.deepEqual(
    await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      return [term.cols, term.rows];
    }, pane),
    ownerSize,
  );
  console.log('PASS multiple viewers share owner dimensions');
  await page.close();
  await second.waitForFunction(
    async ({ id, size }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      return term && (term.cols !== size[0] || term.rows !== size[1]);
    },
    { id: pane, size: ownerSize },
  );
  console.log('PASS dimension ownership transfers on disconnect');
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
}
