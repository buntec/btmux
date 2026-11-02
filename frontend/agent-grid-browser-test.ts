/** Run with `bun browser-test-stack.ts agent-grid-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const backend = process.env.BTMUX_TEST_BACKEND_URL ?? url;
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const encoder = new TextEncoder();

interface Owner {
  id: string;
  ws: WebSocket;
}

const connect = async (pane: string, query: string) => {
  const ws = new (WebSocket as any)(`${backend.replace('http', 'ws')}/ws/pane/${pane}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }) as WebSocket;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return ws;
};

/** A hook-reported agent in a new session, whose resize history ends at `cols`×`rows`. */
const startAgent = async (name: string, cols: number, rows: number): Promise<Owner> => {
  const created = await fetch(`${url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  assert(created.ok);
  const session = await created.json();
  const snapshot = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
  const id = snapshot.windows[0].panes[0].id;
  const ws = await connect(id, `cols=${cols}&rows=${rows}`);
  // Enough output that the replay spans frames.
  for (const [c, r] of [
    [cols - 30, rows - 8],
    [cols + 40, rows + 6],
    [cols - 50, rows - 4],
    [cols, rows],
  ]) {
    ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
    ws.send(encoder.encode('seq 1 20000\n'));
    await Bun.sleep(300);
  }
  // Hook-only agents end at a shell prompt.
  ws.send(encoder.encode('clear; sleep 99999\n'));
  await Bun.sleep(200);
  const hook = await fetch(`${url}/api/panes/${id}/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: name }),
  });
  assert(hook.ok);
  return { id, ws };
};

/** A mirror's frames up to and including `ready`. */
const mirrorFrames = async (pane: string) => {
  const ws = await connect(pane, 'mirror=1');
  return new Promise<any[]>((resolve, reject) => {
    const frames: any[] = [];
    ws.onmessage = (event) => {
      frames.push(typeof event.data === 'string' ? JSON.parse(event.data) : { type: 'data' });
      if (frames.at(-1).type === 'ready') {
        ws.close();
        resolve(frames);
      }
    };
    setTimeout(() => reject(new Error('no ready frame')), 15_000);
  });
};

const setOpen = (page: Page, open: boolean) =>
  page.evaluate(async (open) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setAgentGridOpen(open);
  }, open);

/** Logs tile rects each frame in `__layouts`, from the moment any are visible. */
const watchLayouts = (page: Page) =>
  page.evaluate(() => {
    const state = { layouts: [] as { x: number; y: number; w: number; h: number }[][], stop: false };
    (window as any).__watch = state;
    const tick = () => {
      const area = document.querySelector<HTMLElement>('[data-agent-tiles]');
      if (area && getComputedStyle(area).opacity !== '0') {
        const tiles = [...area.children]
          .map((tile) => tile as HTMLElement)
          .filter((tile) => getComputedStyle(tile).opacity !== '0')
          .map((tile) => ({ x: tile.offsetLeft, y: tile.offsetTop, w: tile.offsetWidth, h: tile.offsetHeight }));
        if (tiles.length) {
          const last = state.layouts.at(-1);
          // Ignore cell measurement rounding.
          const moved =
            !last ||
            last.length !== tiles.length ||
            tiles.some((tile, i) =>
              (['x', 'y', 'w', 'h'] as const).some((key) => Math.abs(tile[key] - last[i][key]) > 2),
            );
          if (moved) state.layouts.push(tiles);
        }
      }
      if (!state.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

/** Waits for the current layout, so what follows can't land before the first sample. */
const baseline = (page: Page) => waitForAsync(page, () => (window as any).__watch.layouts.length > 0);

const stopWatching = (page: Page) =>
  page.evaluate(() => {
    const state = (window as any).__watch;
    state.stop = true;
    return state.layouts as { x: number; y: number; w: number; h: number }[][];
  });

/** All of a tile count's mirrors have shown their replay. */
const replaysShown = (page: Page, count: number) =>
  waitForAsync(
    page,
    (count) =>
      [...document.querySelectorAll<HTMLElement>('[data-agent-mirror] .btm-wterm')].filter(
        (term) => getComputedStyle(term.parentElement!).visibility === 'visible',
      ).length === count,
    count,
  );

const agents = await Promise.all([
  startAgent('agent-a', 200, 50),
  startAgent('agent-b', 120, 40),
  startAgent('agent-c', 90, 24),
  startAgent('agent-d', 160, 45),
]);

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const sockets: WebSocket[] = [];
  (window as any).__sockets = sockets;
  (window as any).WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      const socket = new (target as any)(...args);
      sockets.push(socket);
      return socket;
    },
  });
});
const page = await context.newPage();
try {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // The current size precedes a replay that walks older sizes.
  const frames = await mirrorFrames(agents[0].id);
  assert.deepEqual(frames[0], { type: 'current_size', cols: 200, rows: 50 });
  const replayed = frames.filter((frame) => frame.type === 'size').map((frame) => [frame.cols, frame.rows]);
  assert(replayed.length > 1, `expected resize history, got ${JSON.stringify(replayed)}`);
  assert.deepEqual(replayed.at(-1), [200, 50]);

  await page.goto(`${url}/s/agent-a`);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().agentPanes.size === 4;
  });

  // First open: tiles appear once, at their final layout.
  await watchLayouts(page);
  await setOpen(page, true);
  await replaysShown(page, 4);
  await page.waitForTimeout(300);
  const first = await stopWatching(page);
  assert.equal(first.length, 1, `first open moved tiles: ${JSON.stringify(first)}`);
  const settled = first[0];
  assert.equal(settled.length, 4);
  // Tile widths follow the panes' current columns, not the fallback.
  const widths = settled.map((tile) => tile.w).sort((a, b) => b - a);
  const perColumn = [200, 160, 120, 90].map((cols, i) => widths[i] / cols);
  assert(Math.max(...perColumn) / Math.min(...perColumn) < 1.1, JSON.stringify(settled));

  // Reopening rebuilds the mirrors at the same layout.
  await setOpen(page, false);
  await page.waitForTimeout(200);
  await watchLayouts(page);
  await setOpen(page, true);
  await replaysShown(page, 4);
  await page.waitForTimeout(300);
  const reopened = await stopWatching(page);
  assert.equal(reopened.length, 1, `reopen moved tiles: ${JSON.stringify(reopened)}`);

  // Reconnecting mirrors replay old sizes without moving tiles.
  await watchLayouts(page);
  await baseline(page);
  const mirrorSockets = () =>
    page.evaluate(
      () => ((window as any).__sockets as WebSocket[]).filter((socket) => socket.url.includes('mirror=1')).length,
    );
  const before = await mirrorSockets();
  await page.evaluate(() => {
    for (const socket of (window as any).__sockets as WebSocket[]) {
      if (socket.url.includes('mirror=1') && socket.readyState === WebSocket.OPEN) socket.close();
    }
  });
  await waitForAsync(
    page,
    (count) =>
      ((window as any).__sockets as WebSocket[]).filter((socket) => socket.url.includes('mirror=1')).length >= count,
    before + 4,
  );
  await page.waitForTimeout(1500);
  await replaysShown(page, 4);
  const reconnected = await stopWatching(page);
  assert.equal(reconnected.length, 1, `reconnect moved tiles: ${JSON.stringify(reconnected)}`);

  // A live resize still changes the layout, once.
  await watchLayouts(page);
  await baseline(page);
  agents[2].ws.send(JSON.stringify({ type: 'resize', cols: 180, rows: 48 }));
  await waitForAsync(page, () => (window as any).__watch.layouts.length > 1);
  await page.waitForTimeout(300);
  const resized = await stopWatching(page);
  assert.equal(resized.length, 2, `live resize: ${JSON.stringify(resized)}`);
  const narrowest = (layout: { w: number }[]) => Math.min(...layout.map((tile) => tile.w));
  assert(narrowest(resized[1]) > narrowest(resized[0]), JSON.stringify(resized));

  // A new agent joins in one layout change, without a placeholder size.
  await watchLayouts(page);
  await baseline(page);
  const late = await startAgent('agent-e', 100, 30);
  agents.push(late);
  await replaysShown(page, 5);
  await page.waitForTimeout(300);
  const joined = await stopWatching(page);
  assert.equal(joined.length, 2, `new agent: ${JSON.stringify(joined)}`);
  assert.equal(joined[1].length, 5);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  for (const agent of agents) agent.ws.close();
}
console.log('Agent grid browser tests passed.');
process.exit(0);
