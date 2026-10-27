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

  // Escape must suppress the later release inside the same tile.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.up();
  assert.deepEqual(await tileOrder(page), initial);
  assert.equal(await gridOpen(page), true, 'releasing a canceled drag must not switch panes');

  // Dragged past the grid's corner, the tile stays inside it and adds no scroll overflow.
  const viewport = page.viewportSize();
  assert(viewport);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(viewport.width - 1, viewport.height - 1, { steps: 10 });
  const overflow = await page
    .locator('[data-agent-tile]')
    .first()
    .evaluate((tile) => {
      const area = tile.parentElement!;
      return { x: area.scrollWidth - area.clientWidth, y: area.scrollHeight - area.clientHeight };
    });
  assert.deepEqual(overflow, { x: 0, y: 0 }, 'a dragged tile must not overflow the grid');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);

  // A move without a pressed button (the release went elsewhere) cancels the drag.
  const pointerId = page.evaluate(
    () => new Promise<number>((resolve) => addEventListener('pointerdown', (e) => resolve(e.pointerId), { once: true })),
  );
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  assert.deepEqual(await tileOrder(page), [b, c, a]);
  await page.evaluate(
    ({ pointerId, x, y }) =>
      dispatchEvent(new PointerEvent('pointermove', { pointerId, buttons: 0, clientX: x, clientY: y })),
    { pointerId: await pointerId, ...to },
  );
  assert.deepEqual(await tileOrder(page), initial);
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator(`[data-agent-tile="${a}"]`).evaluate((tile) => (tile as HTMLElement).style.transform),
    '',
  );
  assert.equal(await gridOpen(page), true, 'releasing a lost drag must not switch panes');

  // A single move to the last slot keeps the full drag distance; its click is swallowed.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y);
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

  // Real touch input must reorder instead of starting native panning.
  const touchPage = await browser.newPage({ viewport: { width: 1400, height: 900 }, hasTouch: true, isMobile: true });
  touchPage.on('pageerror', (error) => errors.push(error.message));
  await touchPage.goto(url);
  await touchPage.getByLabel('Access token').fill(token);
  await touchPage.getByRole('button', { name: 'Connect', exact: true }).click();
  await openGrid(touchPage);
  const touchInitial = await tileOrder(touchPage);
  const [first, second, third] = touchInitial as string[];
  const touchFrom = await center(touchPage, first);
  const touchTo = await center(touchPage, third);
  const cdp = await touchPage.context().newCDPSession(touchPage);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...touchFrom, id: 1 }],
  });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: touchFrom.x + ((touchTo.x - touchFrom.x) * i) / 10,
          y: touchFrom.y + ((touchTo.y - touchFrom.y) * i) / 10,
          id: 1,
        },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(await tileOrder(touchPage), [second, third, first], 'touch drag must move the tile');
  assert.equal(await gridOpen(touchPage), true, 'touch drop must not switch panes');
  await touchPage.close();
  assert.deepEqual(errors, []);
  console.log('agent grid browser test passed');
} finally {
  await browser.close();
  for (const session of sessions) await api(`/api/sessions/${session.id}`, 'DELETE');
  rmSync(bin, { recursive: true, force: true });
}
