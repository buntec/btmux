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
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
let socket: WebSocket | null = null;
let scratch: number | null = null;
let original: number | null = null;
let rpc: ((method: string, params: unknown[]) => Promise<any>) | null = null;
try {
  for (const name of ['nvim-review', 'nvim-switch']) {
    sessions.push(await api('/api/sessions', 'POST', { name: `${name}-${Date.now()}` }));
  }
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#access-token'));
  await page.goto(`${url}/s/${encodeURIComponent(sessions[0].name)}`);
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().controlConnectionState === 'connected';
  });

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
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
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
  await page.waitForFunction(async (oldPane) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
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
    await page.waitForFunction(async (pane) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(pane);
      return term && term !== (window as any).nvimOldTerminal && term.element?.style.visibility === 'visible';
    }, pane);
    assert.equal(
      await input.evaluate((el) => document.activeElement === el),
      true,
      'terminal reconstruction preserves Neovim focus',
    );
  }
  console.log('PASS terminal replay and font changes preserve Neovim focus');

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
  socket?.close();
  await browser.close();
  for (const session of sessions) await api(`/api/sessions/${session.id}`, 'DELETE');
}
