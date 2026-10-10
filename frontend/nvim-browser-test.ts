/** Run against an isolated dev stack with Neovim 0.12+: BTMUX_AUTH_TOKEN=... just test-nvim-browser */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { encode, MsgpackStream, type MsgpackExt } from './src/lib/msgpack';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${url}${path}`, { headers, method, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const sessions: { id: string; name: string }[] = [];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BTMUX_TEST_BROWSER,
  args: ['--enable-unsafe-webgpu'],
});
let socket: WebSocket | null = null;
let scratch: number | null = null;
let original: number | null = null;
let originalCompleteopt: string | null = null;
let rpc: ((method: string, params: unknown[]) => Promise<any>) | null = null;
try {
  for (const name of ['nvim-review', 'nvim-switch']) {
    sessions.push(await api('/api/sessions', 'POST', { name: `${name}-${Date.now()}` }));
  }
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).nvimSockets = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).nvimSockets.push(this);
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
  await page.goto(`${url}/s/${encodeURIComponent(sessions[0].name)}`);
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    (window as any).nvimStore = useStore;
  });
  await page.waitForFunction(() => (window as any).nvimStore.getState().controlConnectionState === 'connected');

  await page.evaluate(async () => {
    const { NvimGrid } = await import('/src/lib/nvimGrid.ts' as string);
    const canvas = document.createElement('canvas');
    const font = { family: 'monospace', size: 16, foreground: '#ffffff', background: '#000000', transparent: true };
    const grid = new NvimGrid(canvas, font);
    const w = grid.cellWidth,
      h = grid.cellHeight;
    grid.resizeCanvas((3 * w + 5) / devicePixelRatio, (4 * h + 5) / devicePixelRatio);
    grid.cursorHidden = true;
    grid.redraw([
      ['grid_resize', [1, 3, 4]],
      ['hl_attr_define', [1, { background: 0xff0000 }, {}, []], [2, { reverse: true }, {}, []]],
      ['flush', []],
    ]);
    const ctx = canvas.getContext('2d')!;
    const alpha = (x: number, y: number) => ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
    const check = (value: boolean, message: string) => {
      if (!value) throw new Error(message);
    };
    check(alpha(w / 2, h / 2) === 0 && alpha(3 * w + 2, 4 * h + 2) === 0, 'default cells and margins are transparent');
    grid.redraw([
      [
        'grid_line',
        [
          1,
          0,
          0,
          [
            [' ', 1],
            [' ', 2],
          ],
          false,
        ],
      ],
      ['flush', []],
    ]);
    check(
      alpha(w / 2, h / 2) === 255 && alpha(1.5 * w, h / 2) === 255,
      'explicit and reverse backgrounds remain opaque',
    );
    grid.redraw([
      ['grid_line', [1, 0, 0, [['M', 0, 3]], false]],
      ['flush', []],
    ]);
    grid.redraw([
      ['grid_clear', [1]],
      ['flush', []],
    ]);
    check(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data.every((v) => v === 0),
      'cleared glyphs and backgrounds leave no pixels',
    );
    grid.cursorHidden = false;
    grid.redraw([
      ['grid_cursor_goto', [1, 0, 0]],
      ['flush', []],
    ]);
    check(alpha(w / 2, h / 2) === 255, 'cursor stays visible');
    grid.redraw([
      ['grid_cursor_goto', [1, 1, 0]],
      ['flush', []],
    ]);
    check(alpha(w / 2, h / 2) === 0, 'moving cursor clears old pixels');
    grid.cursorHidden = true;
    grid.setFont({ ...font, transparent: false });
    check(alpha(w / 2, h / 2) === 255 && alpha(3 * w + 2, 4 * h + 2) === 255, 'opaque config fills cells and margins');
    grid.setFont(font);
    grid.redraw([['default_colors_set', [0xffffff, 0x123456, 0xffffff, 0, 0]]]);
    grid.setNormal({ bg: 0x123456 });
    check(alpha(w / 2, h / 2) === 255, 'explicit Normal remains opaque');
    grid.setNormal({});
    check(alpha(w / 2, h / 2) === 0, 'cleared Normal restores transparency');

    const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
    let now = 1000;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    try {
      grid.smoothScroll = 100;
      for (const direction of [1, -1]) {
        grid.redraw([
          ['grid_line', ...Array.from({ length: 4 }, (_, row) => [1, row, 0, [[' ', 1, 3]], false])],
          ['flush', []],
        ]);
        grid.redraw([
          ['grid_scroll', [1, 0, 4, 0, 3, direction, 0]],
          ['grid_line', ...Array.from({ length: 4 }, (_, row) => [1, row, 0, [[' ', 0, 3]], false])],
          ['flush', []],
        ]);
        now += 50;
        grid.redraw([['flush', []]]);
        check(alpha(w / 2, 2 * h) === 0, 'transparent scroll cells never show old content underneath');
        now += 100;
        grid.redraw([['flush', []]]);
        check(alpha(w / 2, h / 2) === 0 && alpha(w / 2, 3.5 * h) === 0, 'finished scroll clears departing pixels');
      }
    } finally {
      if (originalNow) Object.defineProperty(performance, 'now', originalNow);
      else delete (performance as any).now;
    }
  });
  console.log('PASS canvas transparency, explicit backgrounds, cursor clearing, and scrolling in both directions');

  socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws/nvim`, { headers });
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error('Neovim RPC connection failed'));
  });
  const stream = new MsgpackStream();
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  socket.onmessage = (event) => {
    assert.notEqual(typeof event.data, 'string', 'Neovim must be installed');
    for (const message of stream.push(new Uint8Array(event.data as ArrayBuffer))) {
      const [type, id, error, result] = message as [number, number, unknown, unknown];
      if (type !== 1) continue;
      const request = pending.get(id);
      if (!request) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      if (error) request.reject(new Error(JSON.stringify(error)));
      else request.resolve(result);
    }
  };
  rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(encode([0, id, method, params]));
    });
  const bufferId = (value: number | MsgpackExt): number =>
    typeof value === 'number' ? value : (new MsgpackStream().push(value.data)[0] as number);
  original = bufferId(await rpc('nvim_get_current_buf', []));
  originalCompleteopt = await rpc('nvim_get_option_value', ['completeopt', {}]);
  await rpc('nvim_set_option_value', ['completeopt', 'menuone,noselect,popup', {}]);
  // Keep the test's text out of the user's buffers.
  scratch = bufferId(await rpc('nvim_create_buf', [false, true]));
  await rpc('nvim_set_current_buf', [scratch]);
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setNvimOpen(true);
  });
  const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(500);
  await rpc('nvim_input', ['<Esc>']);
  await rpc('nvim_set_current_line', ['']);

  await page.evaluate(async (name) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().navigateFn(`/s/${encodeURIComponent(name)}`);
  }, sessions[1].name);
  await page.waitForFunction(() => {
    const state = (window as any).nvimStore.getState();
    const session = state.allSessions.find((s: any) =>
      location.pathname.startsWith(`/s/${encodeURIComponent(s.name)}/`),
    );
    const pane = session?.windows[session.active_window]?.panes[0];
    return pane && state.terminals.get(pane.id)?.element?.style.visibility === 'visible';
  });
  await page.waitForTimeout(500);
  assert.equal(
    await input.evaluate((el) => document.activeElement === el),
    true,
    'Neovim owns focus after a fresh session mounts',
  );
  await page.keyboard.type('iFOCUS_PROBE');
  await page.keyboard.press('Escape');
  assert.equal(
    await rpc('nvim_get_current_line', []),
    'FOCUS_PROBE',
    'typing reaches the editor after a session switch',
  );
  console.log('PASS Neovim keeps keyboard focus across session switches');

  const oldPane = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const { runAction } = await import('/src/hooks/useKeybindings.ts' as string);
    const state = useStore.getState();
    const session = state.allSessions.find((s: any) =>
      location.pathname.startsWith(`/s/${encodeURIComponent(s.name)}/`),
    );
    runAction('new-window', session.id, state.controlSendFn, () => {});
    return state.getActivePaneId(session.id);
  });
  await page.waitForFunction((oldPane) => {
    const state = (window as any).nvimStore.getState();
    const session = state.allSessions.find((s: any) =>
      location.pathname.startsWith(`/s/${encodeURIComponent(s.name)}/`),
    );
    const pane = session && state.getActivePaneId(session.id);
    return pane !== oldPane && state.terminals.get(pane)?.element?.style.visibility === 'visible';
  }, oldPane);
  assert.equal(
    await input.evaluate((el) => document.activeElement === el),
    true,
    'new terminal replay cannot steal Neovim focus',
  );

  const fontSize = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const { getTerminalFontSize } = await import('/src/state/configDefaults.ts' as string);
    return getTerminalFontSize(useStore.getState().config);
  });
  for (const size of [fontSize + 1, fontSize]) {
    const pane = await page.evaluate(async (size) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      const session = state.allSessions.find((s: any) =>
        location.pathname.startsWith(`/s/${encodeURIComponent(s.name)}/`),
      );
      const pane = state.getActivePaneId(session.id);
      (window as any).nvimOldTerminal = state.terminals.get(pane);
      state.controlSendFn({ type: 'update_config', update: { font_size: size } });
      return pane;
    }, size);
    await page.waitForFunction((pane) => {
      const term = (window as any).nvimStore.getState().terminals.get(pane);
      return term && term !== (window as any).nvimOldTerminal && term.element?.style.visibility === 'visible';
    }, pane);
    assert.equal(
      await input.evaluate((el) => document.activeElement === el),
      true,
      'terminal reconstruction preserves Neovim focus',
    );
  }
  console.log('PASS terminal replay and font changes preserve Neovim focus');

  const update = (update: unknown) =>
    page.evaluate(async (update) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().controlSendFn({ type: 'update_config', update });
    }, update);
  const waitForNvim = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      assert(Date.now() < deadline, 'Neovim theme update timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    const session = state.allSessions.find((s: any) =>
      location.pathname.startsWith(`/s/${encodeURIComponent(s.name)}/`),
    );
    (window as any).nvimPane = state.getActivePaneId(session.id);
    (window as any).nvimTerminal = state.terminals.get((window as any).nvimPane);
    (window as any).nvimCanvas = document
      .querySelector('textarea[aria-label="Neovim input"]')!
      .parentElement!.querySelector('canvas');
    const sockets = (window as any).nvimSockets as WebSocket[];
    (window as any).nvimGuiSocket = sockets.findLast((s) => s.url.endsWith('/ws/nvim'));
    (window as any).nvimPaneSocket = sockets.findLast((s) => s.url.includes(`/ws/pane/${(window as any).nvimPane}`));
    (window as any).nvimSocketCount = sockets.filter(
      (s) => s.url.endsWith('/ws/nvim') || s.url.includes(`/ws/pane/${(window as any).nvimPane}`),
    ).length;
  });
  const editorAlpha = () =>
    input.evaluate((el) => {
      const canvas = el.parentElement!.querySelector('canvas')!;
      return canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
        .data[3];
    });
  for (const colors of ['btmux-default-light', 'btmux-default-dark']) {
    await update({ colors });
    await page.waitForFunction((colors) => {
      return (window as any).nvimStore.getState().config?.active_color_scheme === colors;
    }, colors);
    const palette = await page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().config.color_palette;
    });
    await waitForNvim(
      async () => (await rpc!('nvim_get_hl', [0, { name: 'Normal' }])).fg === parseInt(palette.base05.slice(1), 16),
    );
    assert.equal(await rpc('nvim_get_var', ['colors_name']), 'btmux');
    assert.equal((await rpc('nvim_get_hl', [0, { name: 'Comment' }])).fg, parseInt(palette.base03.slice(1), 16));
    assert.equal((await rpc('nvim_get_hl', [0, { name: 'Function' }])).fg, parseInt(palette.base0D.slice(1), 16));
    assert.equal(await rpc('nvim_get_var', ['terminal_color_9']), palette.base12);
    assert.equal(await rpc('nvim_get_option_value', ['background', {}]), colors.endsWith('light') ? 'light' : 'dark');
  }
  console.log('PASS live light/dark themes synchronize Neovim syntax and Base24 terminal colors');

  // Unset allow-transparency enables it automatically when a wallpaper is selected.
  await update({ wallpaper_shader: 'aurora', wallpaper_opacity: 0.7, wallpaper_resolution: 0.4 });
  await page.waitForFunction(() =>
    ['ready', 'unavailable'].includes(
      document.querySelector<HTMLCanvasElement>('canvas[data-shader-state]')?.dataset.shaderState ?? '',
    ),
  );
  await waitForNvim(
    async () => (await rpc!('nvim_get_hl', [0, { name: 'Normal' }])).bg === undefined && (await editorAlpha()) === 0,
  );
  for (const allow_transparency of [false, true]) {
    await update({ allow_transparency });
    await waitForNvim(async () => (await editorAlpha()) === (allow_transparency ? 0 : 255));
    assert.equal((await rpc('nvim_get_hl', [0, { name: 'Normal' }])).bg === undefined, allow_transparency);
    assert.equal((await rpc('nvim_get_hl', [0, { name: 'Visual' }])).bg !== undefined, true);
  }
  const lifetime = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const term = useStore.getState().terminals.get((window as any).nvimPane);
    const surface = document.querySelector('textarea[aria-label="Neovim input"]')!.parentElement!;
    return {
      same: term === (window as any).nvimTerminal && surface.querySelector('canvas') === (window as any).nvimCanvas,
      sockets:
        (window as any).nvimSockets.filter(
          (s: WebSocket) => s.url.endsWith('/ws/nvim') || s.url.includes(`/ws/pane/${(window as any).nvimPane}`),
        ).length === (window as any).nvimSocketCount &&
        [(window as any).nvimGuiSocket, (window as any).nvimPaneSocket].every(
          (s: WebSocket) => s.readyState === WebSocket.OPEN,
        ),
      hidden: Number(getComputedStyle(term.element.closest('[style*="opacity"]')).opacity) === 0,
      transparent: getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)',
      shader: document.querySelector<HTMLCanvasElement>('canvas[data-shader-state]')!.dataset.shaderState,
    };
  });
  assert(lifetime.same && lifetime.sockets && lifetime.hidden && lifetime.transparent, JSON.stringify(lifetime));
  console.log(
    `PASS wallpaper shows through Neovim while panes stay hidden and sockets stay open (shader ${lifetime.shader})`,
  );

  await page.keyboard.type('a');
  await input.dispatchEvent('keydown', { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true });
  await page.keyboard.press('Escape');
  assert.equal(await rpc('nvim_get_current_line', []), 'FOCUS_PROBE@');
  console.log('PASS AltGr produces text in Neovim');

  const columns = await rpc('nvim_get_option_value', ['columns', {}]);
  const line = `${'x'.repeat(columns - 5)} ab`;
  await rpc('nvim_set_current_line', [line]);
  await rpc('nvim_win_set_cursor', [0, [1, line.length - 1]]);
  await page.keyboard.type('a');
  await rpc('nvim_exec_lua', [
    'vim.fn.complete(...)',
    [
      line.length - 1,
      [
        { word: 'absolute_example_one', info: 'Documentation beside the completion menu.' },
        { word: 'absolute_example_two', info: 'Another completion item.' },
      ],
    ],
  ]);
  const item = page.getByText('absolute_example_one', { exact: true });
  await item.waitFor();
  const assertPopupFits = async () => {
    const fits = await item.evaluate((el) => {
      const popup = el.closest('.astryx-card')!.parentElement!;
      const surface = popup.offsetParent as HTMLElement;
      const bounds = popup.getBoundingClientRect();
      const area = surface.getBoundingClientRect();
      return bounds.left >= area.left - 1 && bounds.right <= area.right + 1;
    });
    assert(fits, 'completion and documentation fit inside the editor');
  };
  await assertPopupFits();
  await page.keyboard.press('Control+n');
  await page.getByText('Documentation beside the completion menu.', { exact: true }).waitFor();
  await assertPopupFits();
  await page.setViewportSize({ width: 640, height: 600 });
  await page.waitForTimeout(300);
  await assertPopupFits();
  console.log('PASS completion and documentation stay within the editor at the right edge and after resizing');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setNvimOpen(false);
  });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Terminal input');
  assert.deepEqual(errors, [], 'session switches and resize must not throw');
  console.log('PASS closing Neovim returns focus to the terminal');
} finally {
  if (rpc && scratch !== null) {
    await rpc('nvim_input', ['<Esc>']).catch(() => {});
    if (original !== null) await rpc('nvim_set_current_buf', [original]).catch(() => {});
    await rpc('nvim_buf_delete', [scratch, { force: true }]).catch(() => {});
  }
  if (rpc && originalCompleteopt !== null) {
    await rpc('nvim_set_option_value', ['completeopt', originalCompleteopt, {}]).catch(() => {});
  }
  socket?.close();
  await browser.close();
  for (const session of sessions) await api(`/api/sessions/${session.id}`, 'DELETE');
}
