/** In-place upgrade keeps shells, replay, and browser sessions. Run with `just test-browser`. */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { waitForAsync } from './browser-test-utils';

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
  return response.status === 202 ? null : response.json();
};
const session = await api('/api/sessions', { name: `upgrade-${Date.now()}` });
const pane = (await api(`/api/sessions/${session.id}`)).windows[0].panes[0].id;
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).testMessages = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
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
  const readyCount = () =>
    page.evaluate(
      (id) => (window as any).testMessages.filter((m: any) => m.type === 'ready' && m.pane_id === id).length,
      pane,
    );
  const until = async (predicate: () => Promise<boolean>, message: string) => {
    for (const deadline = Date.now() + 30_000; !(await predicate().catch(() => false)); ) {
      assert(Date.now() < deadline, message);
      await page.waitForTimeout(100);
    }
  };
  await until(async () => (await readyCount()) > 0, 'pane did not attach');
  const readTerminal = () =>
    page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const buf = useStore.getState().terminals.get(id)?.buffer.active;
      if (!buf) return '';
      return Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join('\n');
    }, pane);
  const waitForText = (pattern: RegExp) =>
    waitForAsync(
      page,
      async ({ id, source }) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        const buf = useStore.getState().terminals.get(id)?.buffer.active;
        if (!buf) return null;
        const text = Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join(
          '\n',
        );
        return text.match(new RegExp(source))?.[1] ?? null;
      },
      { id: pane, source: pattern.source },
    );

  await api(`/api/panes/${pane}/input`, { text: "printf '\\nBEFORE_%s\\n' $$\r" });
  const shell = await waitForText(/\nBEFORE_(\d+)\n/);
  await page.waitForTimeout(250);
  const before = await readTerminal();
  const readyBefore = await readyCount();

  const toasts = () =>
    page.evaluate(() =>
      (window as any).testMessages.filter((m: any) => m.type === 'toast').map((m: any) => `${m.level}: ${m.message}`),
    );
  const refused = await fetch(`${url}/api/server/upgrade`, {
    headers,
    method: 'POST',
    body: JSON.stringify({ executable: '/nonexistent/btmux' }),
  });
  assert.equal(refused.status, 409);
  await until(
    async () => (await toasts()).some((t) => t.startsWith('attention: Upgrade refused: /nonexistent/btmux')),
    'a refused upgrade must notify the browser',
  );
  // A binary that rejects the server's arguments must not take over.
  const dir = mkdtempSync(join(tmpdir(), 'btmux-upgrade-'));
  const rejecting = join(dir, 'btmux');
  writeFileSync(rejecting, "#!/bin/sh\necho \"error: unexpected argument '--port' found\" >&2\nexit 2\n");
  chmodSync(rejecting, 0o755);
  const rejected = await fetch(`${url}/api/server/upgrade`, {
    headers,
    method: 'POST',
    body: JSON.stringify({ executable: rejecting }),
  });
  rmSync(dir, { recursive: true });
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /unexpected argument '--port' found/);

  const info = await api('/api/info');
  await api('/api/server/upgrade', { executable: info.executable });
  await until(
    async () => (await toasts()).includes(`info: Upgrading btmux to ${info.version}…`),
    'an upgrade must notify the browser before it starts',
  );
  await until(async () => (await api('/api/info')).instance !== info.instance, 'server did not come back');
  assert.equal((await api('/api/info')).pid, info.pid, 'an in-place upgrade keeps the pid');
  await until(async () => (await readyCount()) > readyBefore, 'pane did not reattach');
  await page.waitForTimeout(250);
  assert.equal(await readTerminal(), before, 'upgrade must preserve output without duplication');

  await api(`/api/panes/${pane}/input`, { text: "printf '\\nAFTER_%s\\n' $$\r" });
  assert.equal(await waitForText(/\nAFTER_(\d+)\n/), shell, 'the same shell must survive the upgrade');

  // The control socket reconnects and follows structural changes again.
  await api(`/api/sessions/${session.id}/windows`, {});
  await waitForAsync(
    page,
    async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().allSessions.find((s: any) => s.id === id)?.windows.length === 2;
    },
    session.id,
  );
  assert.deepEqual(errors, []);
  console.log('PASS in-place upgrade keeps shells, replay, and browser sessions');
  await context.close();
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
}
