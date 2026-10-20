/** Agent grid tile reordering against the isolated browser-test stack. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${url}${route}`, { method, headers, body: body && JSON.stringify(body) });
  assert(response.ok, `${method} ${route}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};

// `claude` that just sleeps is detected as an agent (a symlink: macOS kills copied system binaries).
const bin = mkdtempSync(path.join(tmpdir(), 'btmux-agents-'));
const claude = path.join(bin, 'claude');
symlinkSync('/bin/sleep', claude);

const sessions: { id: string }[] = [];
const panes: string[] = [];
for (let i = 0; i < 3; i++) {
  const session = await api('/api/sessions', 'POST', { name: `agents-${i}-${Date.now()}` });
  sessions.push(session);
  const snapshot = await api(`/api/sessions/${session.id}`);
  const pane = snapshot.windows[0].panes[0].id;
  panes.push(pane);
  await api(`/api/panes/${pane}/input`, 'POST', { text: `${claude} 600`, keys: ['Enter'] });
}

const tileOrder = (page: Page) =>
  page.locator('[data-agent-tile]').evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-agent-tile')));

async function openGrid(page: Page) {
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    if (state.agentPanes.size < 3) return false;
    state.markAgentGridMounted();
    state.setAgentGridOpen(true);
    return true;
  });
  await page.locator('[data-agent-tile]').nth(2).waitFor();
  // Let tiles settle at their measured sizes.
  await page.waitForTimeout(500);
}

async function center(page: Page, paneId: string) {
  const box = await page.locator(`[data-agent-tile="${paneId}"]`).boundingBox();
  assert(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const gridOpen = (page: Page) =>
  page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().agentGridOpen;
  });

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await openGrid(page);

  const initial = await tileOrder(page);
  assert.deepEqual([...initial].sort(), [...panes].sort());
  const [a, b, c] = initial as string[];

  // Escape cancels a drag without closing the grid.
  const from = await center(page, a);
  const to = await center(page, c);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  assert.deepEqual(await tileOrder(page), [b, c, a]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await tileOrder(page), initial);
  assert.equal(await gridOpen(page), true);
  // Let the tiles slide back.
  await page.waitForTimeout(300);

  // Dropping onto the last slot moves the tile there; the click is swallowed.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  assert.deepEqual(await tileOrder(page), [b, c, a]);
  assert.equal(await gridOpen(page), true);
  assert.equal(
    await page.locator(`[data-agent-tile="${a}"]`).evaluate((tile) => (tile as HTMLElement).style.transform),
    '',
  );

  // Shift+arrow moves the selected (dropped) tile.
  await page.keyboard.press('Shift+ArrowLeft');
  assert.deepEqual(await tileOrder(page), [b, a, c]);

  // A plain click still switches to the pane.
  await page.locator(`[data-agent-tile="${c}"] [data-agent-mirror]`).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return !useStore.getState().agentGridOpen;
  });

  // The order survives a reload.
  await page.reload();
  await openGrid(page);
  assert.deepEqual(await tileOrder(page), [b, a, c]);
  assert.deepEqual(errors, []);
  console.log('agent grid browser test passed');
} finally {
  await browser.close();
  for (const session of sessions) await api(`/api/sessions/${session.id}`, 'DELETE');
  rmSync(bin, { recursive: true, force: true });
}
