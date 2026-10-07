/** Run against an isolated dev stack with BTMUX_AUTH_TOKEN. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const created = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `shaders-${Date.now()}` }),
});
assert(created.ok);
const session = await created.json();
const snapshot = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
const pane = snapshot.windows[0].panes[0].id;
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BTMUX_TEST_BROWSER,
  args: ['--enable-unsafe-webgpu'],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).shaderSockets = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).shaderSockets.push(this);
      }
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#access-token'));
  await page.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await page.locator('.astryx-side-nav').waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    (window as any).shaderStore = useStore;
  });
  await page.waitForFunction((pane) => {
    const term = (window as any).shaderStore.getState().terminals.get(pane);
    const socket = (window as any).shaderSockets.findLast((socket: WebSocket) =>
      socket.url.includes(`/ws/pane/${pane}`),
    );
    if (!term || socket?.readyState !== WebSocket.OPEN) return false;
    (window as any).shaderTerminal = term;
    (window as any).shaderPaneSocket = socket;
    return true;
  }, pane);
  await page.waitForFunction(() =>
    (window as any).shaderSockets.some(
      (socket: WebSocket) => socket.url.endsWith('/ws/control') && socket.readyState === WebSocket.OPEN,
    ),
  );
  const send = (message: unknown) =>
    page.evaluate((message) => {
      const control = (window as any).shaderSockets.findLast(
        (socket: WebSocket) => socket.url.endsWith('/ws/control') && socket.readyState === WebSocket.OPEN,
      );
      control.send(JSON.stringify(message));
    }, message);
  const sameTerminal = async () => {
    const lifetime = await page.evaluate(async (pane) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return {
        same: useStore.getState().terminals.get(pane) === (window as any).shaderTerminal,
        state: (window as any).shaderPaneSocket.readyState,
        count: (window as any).shaderSockets.filter((socket: WebSocket) => socket.url.includes(`/ws/pane/${pane}`))
          .length,
      };
    }, pane);
    assert(
      lifetime.same && lifetime.state === 1 && lifetime.count === 1,
      `wallpaper lifetime changed: ${JSON.stringify(lifetime)}`,
    );
  };
  await send({
    type: 'update_config',
    update: {
      wallpaper_shader: 'aurora',
      wallpaper_opacity: 0.7,
      wallpaper_resolution: 0.4,
      wallpaper_fps: 20,
      wallpaper_shader_follows_mouse_cursor: false,
      wallpaper_shader_params: { aurora: { 'color-a': '#123456', 'curtain-count': 2 } },
    },
  });
  const canvas = page.locator('canvas[data-shader-state]');
  await page.waitForFunction(() =>
    ['ready', 'unavailable'].includes(
      document.querySelector<HTMLCanvasElement>('canvas[data-shader-state]')?.dataset.shaderState ?? '',
    ),
  );
  const available = (await canvas.getAttribute('data-shader-state')) === 'ready';
  await sameTerminal();
  if (available) {
    const geometry = await canvas.evaluate((canvas: HTMLCanvasElement) => ({
      width: canvas.width,
      cssWidth: canvas.getBoundingClientRect().width,
      dpr: devicePixelRatio,
    }));
    assert(Math.abs(geometry.width - geometry.cssWidth * geometry.dpr * 0.4) <= 1);
    const capture = () => canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    const initial = await capture();
    await send({
      type: 'update_config',
      update: {
        animations: false,
        wallpaper_shader_params: {
          aurora: { 'color-a': '#ff0000', 'color-b': '#00ff00', 'color-c': '#0000ff', 'curtain-count': 3 },
        },
      },
    });
    await page.waitForFunction(() => !(window as any).shaderStore.getState().config.animations);
    await page.waitForTimeout(250);
    assert.notEqual(await capture(), initial, 'native parameter changes must change rendered pixels');
    const frozen = await capture();
    await page.waitForTimeout(250);
    assert.equal(await capture(), frozen, 'disabled animations must preserve the last frame');
    console.log('PASS WebGPU rendering, resolution, live parameters, and frozen animation');
    const generators = await page.evaluate(async () => {
      const { WALLPAPER_SHADERS } = await import('/src/lib/wallpaperCatalog.ts' as string);
      const { loadWallpaperRenderer } = await import('/src/lib/wallpaperRenderer.ts' as string);
      const unavailable: string[] = [];
      for (const shader of WALLPAPER_SHADERS) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;width:120px;height:80px;opacity:0;pointer-events:none';
        document.body.append(canvas);
        const create = await loadWallpaperRenderer(shader.id);
        const renderer = create!(
          canvas,
          { params: {}, seed: 'test', speed: 1, fps: 10, resolution: 0.4, animated: false, paused: false },
          () => unavailable.push(shader.id),
        );
        try {
          await renderer.initialize();
        } finally {
          renderer.dispose();
          canvas.remove();
        }
      }
      return unavailable;
    });
    assert.deepEqual(generators, [], 'all native generators must initialize');
    console.log('PASS all 18 native generators initialize');
  } else console.log('SKIP WebGPU pixel checks: the test browser has no usable adapter');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Wallpaper', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Color A', exact: true }).fill('#abcdef');
  await dialog.getByRole('switch', { name: 'Show TOML', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy TOML', exact: true }).click();
  const toml = await page.evaluate(() => navigator.clipboard.readText());
  const exported = Bun.TOML.parse(toml) as any;
  assert.equal(exported['wallpaper-shader-params'].aurora['color-a'], '#abcdef');
  assert(!('shader' in exported));
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () => (window as any).shaderStore.getState().config.wallpaper_shader_params.aurora['color-a'] === '#abcdef',
  );
  await sameTerminal();
  assert.equal(await page.locator('iframe[src*="radiant"], iframe[src*="shaders"]').count(), 0);
  assert(
    !requests.some((request) => request.includes('shaders.com')),
    'shaders must not download assets or send telemetry',
  );
  assert.deepEqual(errors, []);
  console.log('PASS shader Settings, TOML export, server overrides, and terminal/socket lifetime');
  const fallback = await browser.newContext();
  await fallback.addInitScript(() =>
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }),
  );
  const fallbackPage = await fallback.newPage();
  await fallbackPage.goto(url);
  await fallbackPage.getByLabel('Access token').fill(token);
  await fallbackPage.getByRole('button', { name: 'Connect', exact: true }).click();
  await fallbackPage.waitForFunction(() => !document.querySelector('#access-token'));
  await fallbackPage.waitForFunction(
    () => document.querySelector<HTMLCanvasElement>('canvas[data-shader-state]')?.dataset.shaderState === 'unavailable',
  );
  assert.equal(
    await fallbackPage.locator('canvas[data-shader-state]').evaluate((canvas) => getComputedStyle(canvas).visibility),
    'hidden',
  );
  console.log('PASS graceful fallback without WebGPU');
  await send({ type: 'reset_config' });
  await context.close();
  await fallback.close();
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
}
