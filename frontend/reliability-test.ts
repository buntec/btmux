/** Run with `just test-browser`, or against a running stack with BTMUX_TEST_URL and BTMUX_AUTH_TOKEN. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  await waitForAsync(
    page,
    async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      return term && (window as any).testMessages.some((m: any) => m.type === 'ready' && m.pane_id === id);
    },
    pane,
  );
  await api(`/api/panes/${pane}/input`, { text: "printf '\\nREPLAY_🙂_OK\\n'\r" });
  const readTerminal = async () =>
    page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().terminals.get(id).readLines().join('\n');
    }, pane);
  await waitForAsync(
    page,
    async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      // A config update can rebuild the terminal, briefly unregistering it.
      const term = useStore.getState().terminals.get(id);
      return !!term && term.readLines().join('\n').includes('\nREPLAY_🙂_OK\n');
    },
    pane,
  );
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
      .findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control')
      .send(JSON.stringify({ type: 'update_config', update: { animations: true }, request_id: 'config-test' }));
  }, pane);
  await waitForAsync(page, async () => {
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

  // `appearance = "auto"` follows the system color mode this browser reports.
  const colorMode = (mode: 'dark' | 'light') =>
    waitForAsync(
      page,
      async (mode) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        const config = useStore.getState().config;
        return config.color_mode === mode && config.theme.background === config[`${mode}_theme`].background;
      },
      mode,
    );
  await page.emulateMedia({ colorScheme: 'dark' });
  await colorMode('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await colorMode('light');
  assert(
    await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().terminals.get(id) === (window as any).testTerminal;
    }, pane),
    'a theme switch must keep the terminal instance',
  );
  await page.evaluate(() =>
    (window as any).testSockets
      .findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control')
      .send(JSON.stringify({ type: 'update_config', update: { appearance: 'dark' } })),
  );
  await colorMode('dark');
  console.log('PASS auto appearance follows the system color mode');

  // Only an isolated stack's config may be edited.
  const configHome = process.env.BTMUX_TEST_CONFIG_HOME;
  if (configHome) {
    const configFile = path.join(configHome, 'btmux', 'config.toml');
    const original = readFileSync(configFile, 'utf8');
    const banner = page.getByText('Config error: config.toml was rejected');
    writeFileSync(configFile, 'not-a-setting = true\n');
    await banner.waitFor();
    const details = page.getByText('unknown field `not-a-setting`');
    assert.equal(await details.count(), 0, 'the full error must stay behind the button');
    await page.getByRole('button', { name: 'Show error' }).click();
    await details.waitFor();
    await page.keyboard.press('Escape');
    await details.waitFor({ state: 'detached' });
    // Settings changes keep the warning while the file is still rejected.
    await page.evaluate(() =>
      (window as any).testSockets
        .findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control')
        .send(JSON.stringify({ type: 'update_config', update: { animations: true } })),
    );
    await page.waitForTimeout(500);
    assert(await banner.isVisible(), 'the config error must stay visible');
    // Fixing the file removes the banner and closes an open error dialog.
    await page.getByRole('button', { name: 'Show error' }).click();
    await details.waitFor();
    writeFileSync(configFile, original);
    await banner.waitFor({ state: 'detached' });
    await details.waitFor({ state: 'detached' });
    console.log('PASS rejected config shows a warning until it loads');

    const rebuilt = async () => {
      const previous = await page.evaluateHandle(async (id) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        return useStore.getState().terminals.get(id);
      }, pane);
      return () =>
        waitForAsync(
          page,
          async ([id, previous]) => {
            const { useStore } = await import('/src/state/store.tsx' as string);
            const term = useStore.getState().terminals.get(id);
            return !!term && term !== previous && term.element.parentElement?.style.visibility === 'visible';
          },
          [pane, previous] as const,
        );
    };
    let ready = await rebuilt();
    writeFileSync(configFile, '[terminal]\nfont-size = 36\ndisable-stdin = true\n');
    await ready();
    const terminal = await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      const line = document.createElement('div');
      line.textContent = 'Wg';
      line.style.cssText = 'position:absolute;line-height:normal';
      term.element.appendChild(line);
      const fontHeight = line.getBoundingClientRect().height;
      line.remove();
      return { rowHeight: term.measureCell().height, fontHeight };
    }, pane);
    assert(terminal.rowHeight >= terminal.fontHeight, JSON.stringify(terminal));
    await page.locator('textarea[aria-label="Terminal"]').first().focus();
    await page.keyboard.type('echo TYPED_$((6*7))\n');
    await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().terminals.get(id).paste('echo PASTED_$((6*7))\n');
    }, pane);
    await page.waitForTimeout(500);
    const output = await (await fetch(`${url}/api/panes/${pane}/output`, { headers })).text();
    assert(!/TYPED|PASTED/.test(await readTerminal()), 'disabled input must not echo locally');
    assert(!/TYPED_42|PASTED_42/.test(output), 'disabled input must not reach the PTY');
    ready = await rebuilt();
    writeFileSync(configFile, original);
    await ready();
    console.log('PASS rows fit the font and disable-stdin blocks input');
  }
  await page.evaluate(() => {
    (window as any).testSockets
      .findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control')
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
    () => (window as any).testSockets.filter((s: WebSocket) => new URL(s.url).pathname === '/ws/control').length,
  );
  await page.evaluate(() =>
    (window as any).testSockets.findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control').close(),
  );
  await waitForAsync(
    page,
    async (count) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return (
        useStore.getState().controlConnectionState === 'connected' &&
        (window as any).testSockets.filter((s: WebSocket) => new URL(s.url).pathname === '/ws/control').length > count
      );
    },
    controlCount,
  );
  console.log('PASS correlated command errors and control reconnect');

  const second = await context.newPage();
  await second.setViewportSize({ width: 800, height: 600 });
  const ownerSize = await page.evaluate(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const term = useStore.getState().terminals.get(id);
    return [term.cols, term.rows];
  }, pane);
  await second.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await waitForAsync(
    second,
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
  const termSize = (target: typeof page) =>
    target.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      return [term.cols, term.rows];
    }, pane);
  const waitForSize = (target: typeof page, size: number[], equal: boolean) =>
    waitForAsync(
      target,
      async ({ id, size, equal }) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        const term = useStore.getState().terminals.get(id);
        return term && (term.cols === size[0] && term.rows === size[1]) === equal;
      },
      { id: pane, size, equal },
    );
  await second.locator('textarea[aria-label="Terminal"]').first().press('Shift');
  await waitForSize(second, ownerSize, false);
  const claimedSize = await termSize(second);
  await waitForSize(page, claimedSize, true);
  console.log('PASS keyboard input claims dimension ownership');
  await page.locator('textarea[aria-label="Terminal"]').first().press('Shift');
  await waitForSize(second, ownerSize, true);
  await page.close();
  await waitForAsync(
    second,
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

  // macOS Cmd editing chords reach the pane as readline keys unless disabled.
  const macContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await macContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    (window as any).testSockets = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).testSockets.push(this);
      }
    };
  });
  const mac = await macContext.newPage();
  const macErrors: string[] = [];
  mac.on('pageerror', (error) => macErrors.push(error.message));
  await mac.goto(url);
  await mac.getByLabel('Access token').fill(token);
  await mac.getByRole('button', { name: 'Connect', exact: true }).click();
  await mac.waitForFunction(() => !document.querySelector('#access-token'));
  await mac.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await waitForAsync(
    mac,
    async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      if (!term) return false;
      (window as any).testInput = [];
      term.onData((data: Uint8Array) => (window as any).testInput.push(new TextDecoder().decode(data)));
      return true;
    },
    pane,
  );
  const macInput = mac.locator('textarea[aria-label="Terminal"]').first();
  const chords = async () => {
    await mac.evaluate(() => ((window as any).testInput.length = 0));
    for (const chord of ['Meta+ArrowLeft', 'Meta+ArrowRight', 'Meta+Backspace', 'Meta+Delete', 'Meta+Shift+ArrowLeft'])
      await macInput.press(chord);
    return mac.evaluate(() => (window as any).testInput.join(''));
  };
  assert.equal(await chords(), '\x01\x05\x15\x0b\x1b[1;10D');
  // Outside panes, the chords never reach the page's handlers.
  await mac.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'cmd-chord-probe';
    input.addEventListener('keydown', () => ((window as any).probeKeys = ((window as any).probeKeys ?? 0) + 1));
    document.body.append(input);
  });
  await mac.locator('#cmd-chord-probe').press('Meta+ArrowLeft');
  assert.equal(await mac.evaluate(() => (window as any).probeKeys ?? 0), 0);
  await mac.evaluate(() => document.getElementById('cmd-chord-probe')!.remove());
  const setEditKeys = async (value: boolean) => {
    await mac.evaluate(
      (value) =>
        (window as any).testSockets
          .findLast((s: WebSocket) => new URL(s.url).pathname === '/ws/control')
          .send(JSON.stringify({ type: 'update_config', update: { macos_edit_keys: value } })),
      value,
    );
    await waitForAsync(
      mac,
      async (value) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        return useStore.getState().config.terminal.macosEditKeys === value;
      },
      value,
    );
  };
  await setEditKeys(false);
  assert.equal(await chords(), '');
  await setEditKeys(true);
  console.log('PASS macOS Cmd editing keys');
  assert.deepEqual(macErrors, []);
  await macContext.close();
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
}
