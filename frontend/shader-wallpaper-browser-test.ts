/** Run with `just test-browser`, or against a running stack with BTMUX_TEST_URL and BTMUX_AUTH_TOKEN. */
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
      (socket: WebSocket) => new URL(socket.url).pathname === '/ws/control' && socket.readyState === WebSocket.OPEN,
    ),
  );
  const send = (message: unknown) =>
    page.evaluate((message) => {
      const control = (window as any).shaderSockets.findLast(
        (socket: WebSocket) => new URL(socket.url).pathname === '/ws/control' && socket.readyState === WebSocket.OPEN,
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
  const layer = (shader: string, extra: Record<string, unknown> = {}) => ({
    shader,
    enabled: true,
    'blend-mode': 'normal',
    opacity: 1,
    interactive: true,
    params: {},
    ...extra,
  });
  await send({
    type: 'update_config',
    update: {
      wallpaper_shaders: [layer('aurora', { params: { 'color-a': '#123456', 'curtain-count': 2 } })],
      wallpaper_opacity: 0.7,
      wallpaper_resolution: 0.4,
      wallpaper_fps: 20,
      wallpaper_shader_follows_mouse_cursor: false,
    },
  });
  const canvas = page.locator('canvas[data-shader-state]');
  const capture = () => canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  /** Wait for a redraw; software WebGPU (as on CI) can take a while. */
  const redrawn = async (before: string, message: string) => {
    const deadline = Date.now() + 10_000;
    while ((await capture()) === before) {
      assert(Date.now() < deadline, message);
      await page.waitForTimeout(100);
    }
  };
  /** Wait until the renderer shows exactly these layers. */
  const showing = (ids: string[]) =>
    page.waitForFunction((ids) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-shader-state]');
      return canvas?.dataset.shaderState === 'ready' && canvas.dataset.shaderLayers === ids.join(' ');
    }, ids);
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
    const initial = await capture();
    await send({
      type: 'update_config',
      update: {
        animations: false,
        wallpaper_shaders: [
          layer('aurora', {
            params: { 'color-a': '#ff0000', 'color-b': '#00ff00', 'color-c': '#0000ff', 'curtain-count': 3 },
          }),
        ],
      },
    });
    await page.waitForFunction(() => !(window as any).shaderStore.getState().config.animations);
    await redrawn(initial, 'native parameter changes must change rendered pixels');
    const frozen = await capture();
    await page.waitForTimeout(250);
    assert((await capture()) === frozen, 'disabled animations must preserve the last frame');
    console.log('PASS WebGPU rendering, resolution, live parameters, and frozen animation');

    const configure = async (update: Record<string, unknown>) => {
      await send({ type: 'update_config', update });
      await page.waitForFunction(
        (update) =>
          Object.entries(update).every(
            ([key, value]) =>
              JSON.stringify((window as any).shaderStore.getState().config[key]) === JSON.stringify(value),
          ),
        update,
      );
      await page.waitForTimeout(150);
    };
    const base = (await page.evaluate(() => (window as any).shaderStore.getState().config.wallpaper_shaders))[0];
    await configure({ wallpaper_shaders: [base, layer('invert')] });
    await showing(['aurora', 'invert']);
    await redrawn(frozen, 'an effect layer must process the layers beneath it');
    const inverted = await capture();
    await configure({ wallpaper_shaders: [base, layer('invert', { opacity: 0.5, 'blend-mode': 'multiply' })] });
    await redrawn(inverted, 'layer opacity and blend mode must change rendered pixels');
    await configure({ wallpaper_shaders: [base, layer('invert', { enabled: false })] });
    await showing(['aurora']);
    await configure({ wallpaper_shaders: [layer('invert'), base] });
    await showing(['invert', 'aurora']);
    console.log('PASS effect layers, opacity, blend modes, disabling, and reordering');

    const unavailable = await page.evaluate(async () => {
      const { WALLPAPER_SHADERS, createShaderLayer } = await import('/src/lib/wallpaperCatalog.ts' as string);
      const { createWallpaperRenderer } = await import('/src/lib/wallpaperRenderer.ts' as string);
      const { randomizeShaderParams } = await import('/src/lib/wallpaperRandomize.ts' as string);
      const unavailable: string[] = [];
      for (const shader of WALLPAPER_SHADERS) {
        for (const params of [{}, randomizeShaderParams(shader, {})]) {
          const canvas = document.createElement('canvas');
          canvas.style.cssText = 'position:fixed;width:120px;height:80px;opacity:0;pointer-events:none';
          document.body.append(canvas);
          const layers = [{ ...createShaderLayer(shader.id), params }];
          // Effects need content beneath them.
          if (shader.kind === 'effect') layers.unshift(createShaderLayer('aurora'));
          const renderer = createWallpaperRenderer(
            canvas,
            {
              layers,
              speed: 1,
              fps: 10,
              resolution: 0.4,
              animated: false,
              paused: false,
              followsMouseCursor: true,
              followsKeyboardInput: false,
            },
            () => unavailable.push(shader.id),
          );
          try {
            await renderer.initialize();
          } finally {
            renderer.dispose();
            canvas.remove();
          }
        }
      }
      return unavailable;
    });
    assert.deepEqual(unavailable, [], 'all native shaders must initialize');
    console.log('PASS all native generators and effects initialize with default and randomized parameters');

    const interactive = ['chroma-flow', 'cursor-trail', 'ink-flow', 'boids'];
    const move = async (keyboard = false) => {
      for (let step = 0; step <= 12; step++) {
        const x = 150 + step * 50;
        const y = 250 + Math.sin(step / 3) * 100;
        if (keyboard)
          await page.evaluate(
            ({ x, y }) =>
              window.dispatchEvent(new CustomEvent('btmux:wallpaper-keyboard-cursor', { detail: { x, y } })),
            { x, y },
          );
        else await page.mouse.move(x, y);
        await page.waitForTimeout(60);
      }
    };
    for (const id of interactive) {
      await configure({
        wallpaper_shaders: [layer(id)],
        animations: true,
        wallpaper_speed: 1,
        wallpaper_shader_follows_mouse_cursor: false,
        wallpaper_shader_follows_keyboard_input: false,
      });
      await showing([id]);
      const idle = await capture();
      await move();
      if (id !== 'boids') {
        assert((await capture()) === idle, `${id} must ignore disabled pointer input`);
        // Simulations keep moving after input, so check this while still idle.
        await configure({
          wallpaper_shaders: [layer(id, { interactive: false })],
          wallpaper_shader_follows_mouse_cursor: true,
        });
        await move();
        assert((await capture()) === idle, `${id} must ignore input when the layer is not interactive`);
        await configure({ wallpaper_shaders: [layer(id)] });
      } else {
        await redrawn(idle, 'Boids must animate without pointer input');
        await configure({ wallpaper_shader_follows_mouse_cursor: true });
      }
      const before = await capture();
      await move();
      await redrawn(before, `${id} must respond to pointer movement`);
      await configure({ animations: false });
      const frozen = await capture();
      await move();
      assert((await capture()) === frozen, `${id} must freeze with animations disabled`);
      await configure({ animations: true, wallpaper_speed: 0 });
      const stopped = await capture();
      await move();
      assert((await capture()) === stopped, `${id} must freeze at zero global speed`);
      await configure({
        wallpaper_speed: 1,
        wallpaper_shader_follows_mouse_cursor: false,
        wallpaper_shader_follows_keyboard_input: true,
      });
      const keyboard = await capture();
      await move(true);
      await redrawn(keyboard, `${id} must respond to terminal cursor movement`);
      await sameTerminal();
      console.log(`PASS ${id} pointer input, layer interactivity, terminal cursor, animation pause, and zero speed`);
    }
    await configure({
      wallpaper_shaders: [layer('ink-flow'), layer('pixelate')],
      animations: true,
      wallpaper_speed: 1,
      wallpaper_shader_follows_mouse_cursor: true,
      wallpaper_shader_follows_keyboard_input: false,
    });
    await showing(['ink-flow', 'pixelate']);
    const stacked = await capture();
    await move();
    await redrawn(stacked, 'an interactive generator must respond to input beneath an effect');
    console.log('PASS interactive generator beneath an effect');
    await configure({
      animations: false,
      wallpaper_shader_follows_mouse_cursor: false,
      wallpaper_shader_follows_keyboard_input: false,
    });
  } else console.log('SKIP WebGPU pixel checks: the test browser has no usable adapter');

  await send({
    type: 'update_config',
    update: {
      wallpaper_shaders: [layer('aurora', { params: { seed: 17 } }), layer('chroma-flow', { params: { radius: 2 } })],
    },
  });
  await page.waitForFunction(
    () => (window as any).shaderStore.getState().config.wallpaper_shaders[0]?.params.seed === 17,
  );
  const preview = () => page.evaluate(() => (window as any).shaderStore.getState().configPreview.wallpaper_shaders);
  const previewHas = (ids: string[]) =>
    page.waitForFunction(
      (ids) =>
        JSON.stringify(
          (window as any).shaderStore.getState().configPreview.wallpaper_shaders.map((layer: any) => layer.shader),
        ) === JSON.stringify(ids),
      ids,
    );
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Wallpaper', exact: true }).click();
  const first = dialog.getByRole('group', { name: 'Layer 1: Aurora', exact: true });
  await first.getByRole('button', { name: 'Aurora settings' }).click();
  await first.getByRole('button', { name: 'Reset parameters', exact: true }).click();
  await page.waitForFunction(
    () => Object.keys((window as any).shaderStore.getState().configPreview.wallpaper_shaders[0].params).length === 0,
  );
  const defaultSeed = await page.evaluate(async () => {
    const { findWallpaperShader } = await import('/src/lib/wallpaperCatalog.ts' as string);
    return findWallpaperShader('aurora')!.params.find((param) => param.name === 'seed')!.default;
  });
  assert.equal(
    Number(await first.getByRole('slider', { name: 'Seed', exact: true }).getAttribute('aria-valuenow')),
    defaultSeed,
  );
  await first.getByRole('textbox', { name: 'Color A', exact: true }).fill('#abcdef');
  assert(
    await first.getByRole('slider', { name: 'Seed', exact: true }).evaluate((seed) => {
      const button = [...seed.closest('[role="group"]')!.querySelectorAll('button')].find(
        (button) => button.textContent === 'Randomize parameters',
      );
      return !!button && !!(seed.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
    'Randomize must follow the shader parameter controls',
  );
  await first.getByRole('button', { name: 'Randomize parameters', exact: true }).click();
  await page.waitForFunction(
    () => (window as any).shaderStore.getState().configPreview.wallpaper_shaders[0].params.seed !== undefined,
  );
  assert.notEqual(await first.getByRole('textbox', { name: 'Color A', exact: true }).inputValue(), '#abcdef');
  assert.equal(
    await page.evaluate(() => (window as any).shaderStore.getState().config.wallpaper_shaders[0].params.seed),
    17,
    'Randomize must stay in the local preview until Apply',
  );
  assert.deepEqual((await preview())[1].params, { radius: 2 }, 'Randomize must only change its own layer');

  // Searchable selectors render as buttons.
  const pick = async (selector: string, option: string) => {
    await dialog.getByRole('button', { name: selector, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await pick('Layer 1', 'Grid');
  await previewHas(['grid', 'chroma-flow']);
  assert.deepEqual((await preview())[0].params, {}, 'changing a layer shader must reset its parameters');
  if (available) await showing(['grid', 'chroma-flow']);
  const grid = dialog.getByRole('group', { name: 'Layer 1: Grid', exact: true });
  await grid.getByRole('button', { name: 'Grid settings' }).click();
  const beforeGrid = available ? await capture() : null;
  await grid.getByRole('button', { name: 'Randomize parameters', exact: true }).click();
  await page.waitForFunction(
    () => Object.keys((window as any).shaderStore.getState().configPreview.wallpaper_shaders[0].params).length === 8,
  );
  if (available) await redrawn(beforeGrid!, 'static shaders must redraw after randomization');

  await pick('Add shader layer', 'Film Grain');
  await previewHas(['grid', 'chroma-flow', 'film-grain']);
  if (available) await showing(['grid', 'chroma-flow', 'film-grain']);
  await dialog.getByRole('button', { name: 'Move layer 3 up', exact: true }).click();
  await previewHas(['grid', 'film-grain', 'chroma-flow']);
  await dialog.getByRole('button', { name: 'Remove layer 3', exact: true }).click();
  await previewHas(['grid', 'film-grain']);
  const grain = dialog.getByRole('group', { name: 'Layer 2: Film Grain', exact: true });
  await grain.getByRole('button', { name: 'Film Grain settings' }).click();
  await grain.getByRole('combobox', { name: 'Blend mode', exact: true }).click();
  await page.getByRole('option', { name: 'Soft light', exact: true }).click();
  await grain.getByRole('switch', { name: 'Layer 2 enabled', exact: true }).click();
  await page.waitForFunction(() => {
    const grain = (window as any).shaderStore.getState().configPreview.wallpaper_shaders[1];
    return grain['blend-mode'] === 'soft-light' && !grain.enabled;
  });
  if (available) await showing(['grid']);
  for (let count = 2; count < 8; count++) await pick('Add shader layer', 'Vignette');
  assert(
    await dialog.getByRole('button', { name: 'Add shader layer', exact: true }).isDisabled(),
    'the stack must stop at 8 layers',
  );

  const layers = await preview();
  await dialog.getByRole('switch', { name: 'Show TOML', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy TOML', exact: true }).click();
  const toml = await page.evaluate(() => navigator.clipboard.readText());
  const exported = (Bun.TOML.parse(toml) as any)['wallpaper-shader'].map((entry: any) => layer(entry.shader, entry));
  assert.deepEqual(exported, layers);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction((layers) => {
    // The server sorts parameter keys.
    const canonical = (value: unknown) =>
      JSON.stringify(value, (_, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      );
    return canonical((window as any).shaderStore.getState().config.wallpaper_shaders) === canonical(layers);
  }, layers);
  await sameTerminal();
  assert.equal(await page.locator('iframe[src*="shaders"]').count(), 0);
  assert(
    !requests.some((request) => request.includes('shaders.com')),
    'shaders must not download assets or send telemetry',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS layer editing, Randomize placement, seed overrides, previews, TOML export, and terminal/socket lifetime',
  );
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
