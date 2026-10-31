/** Run with `just test-browser`, or against a running stack with BTMUX_TEST_URL and BTMUX_AUTH_TOKEN. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForAsync } from './browser-test-utils';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { FALLBACK_DARK_THEME } from './src/state/startupTheme';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
// A throwaway repo with a staged change, independent of the user's Git config.
const repo = mkdtempSync(path.join(tmpdir(), 'btmux-git-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '--initial-branch=main');
writeFileSync(path.join(repo, 'README'), 'one\n');
git('add', 'README');
git('commit', '-m', 'Initial');
writeFileSync(path.join(repo, 'README'), 'two\n');
git('add', 'README');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `astryx-${Date.now()}` }),
});
assert(response.ok);
const session = await response.json();
const snapshot = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
const pane = snapshot.windows[0].panes[0].id;
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const startup = await browser.newContext();
  await startup.addInitScript(
    (theme) => {
      localStorage.setItem('btmux-appearance', 'dark');
      localStorage.setItem('btmux-theme-dark', JSON.stringify(theme));
    },
    {
      ...FALLBACK_DARK_THEME,
      background: '#273549',
    },
  );
  await startup.route('**/api/sessions', (route) => route.fulfill({ json: [] }));
  await startup.routeWebSocket(/\/ws\/control/, () => {});
  const loadingPage = await startup.newPage();
  await loadingPage.goto(url);
  await loadingPage.getByText('Connecting to btmux', { exact: true }).waitFor();
  assert.equal(
    await loadingPage.locator('.bg-body').evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(39, 53, 73)',
  );
  assert.equal(await loadingPage.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(39, 53, 73)');
  await loadingPage.reload();
  await loadingPage.getByText('Connecting to btmux', { exact: true }).waitFor();
  assert.equal(
    await loadingPage.locator('.bg-body').evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(39, 53, 73)',
  );
  await startup.close();
  console.log('PASS cached loading-screen palette before config arrives');

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-write'],
  });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).processTestSockets = [];
    (window as any).processTestCommands = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (this.url.endsWith('/ws/processes')) (window as any).processTestSockets.push(this);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.url.endsWith('/ws/processes') && typeof data === 'string') {
          (window as any).processTestCommands.push(JSON.parse(data));
        }
        if (this.url.includes('/ws/pane/') && typeof data !== 'string') {
          (window as any).paneTestInput = ((window as any).paneTestInput ?? '') + new TextDecoder().decode(data as any);
        }
        super.send(data);
      }
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401')) errors.push(message.text());
  });
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#access-token'));
  await page.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await page.locator('.astryx-side-nav').waitFor();
  await waitForAsync(
    page,
    async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = useStore.getState().terminals.get(id);
      if (!term || !useStore.getState().config) return false;
      (window as any).astryxTestTerminal = term;
      return true;
    },
    pane,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // The nav mounts collapsed; its rail items still get tooltips.
  await page.getByRole('button', { name: 'Switch session', exact: true }).hover();
  await page.getByRole('tooltip').filter({ hasText: 'Switch session' }).waitFor();
  await page.mouse.move(0, 0);
  const theme = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const config = useStore.getState().config;
    const { getTerminalFontFamily } = await import('/src/state/configDefaults.ts' as string);
    const css = getComputedStyle(document.body);
    const mono = document.querySelector('.btm-mono');
    return {
      background: css.getPropertyValue('--color-background-body').trim(),
      palette: config.theme.background,
      font: css.fontFamily,
      monoFont: mono ? getComputedStyle(mono).fontFamily : '',
      terminalFont: getTerminalFontFamily(config),
    };
  });
  assert.equal(theme.background, theme.palette);
  assert(theme.font.includes('Geist Variable'));
  assert(theme.monoFont.includes(theme.terminalFont));

  const portListener = createServer();
  const udpSocket = createSocket('udp4');
  const portClients: Socket[] = [];
  await new Promise<void>((resolve) => portListener.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => udpSocket.bind(0, '127.0.0.1', resolve));
  try {
    const tcpPort = (portListener.address() as { port: number }).port;
    const udpPort = udpSocket.address().port;
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve) => {
        portClients.push(createConnection({ port: tcpPort, host: '127.0.0.1' }, resolve));
      });
    }
    await page.evaluate(async (pane) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, null, pane, 'process');
    }, pane);
    const viewer = page.getByRole('dialog', { name: 'Processes', exact: true });
    await viewer.getByRole('list', { name: 'Processes', exact: true }).waitFor();
    await page.keyboard.press('p');
    await viewer.getByText('Ports', { exact: true }).waitFor();
    await waitForAsync(
      page,
      async ({ tcpPort, udpPort, pid }) => {
        const { useProcessStore } = await import('/src/state/processStore.ts' as string);
        const ports = useProcessStore.getState().snapshot?.ports ?? [];
        return (
          ports.some((port) => port.pid === pid && port.local_port === tcpPort && port.protocol === 'TCP') &&
          ports.some((port) => port.pid === pid && port.local_port === udpPort && port.protocol === 'UDP')
        );
      },
      { tcpPort, udpPort, pid: process.pid },
    );
    await viewer.getByText('sort: listeners first', { exact: true }).waitFor();
    const assertListenersFirst = async () => {
      const states = await viewer.locator('tr[data-port-focused] > td:nth-child(4)').allTextContents();
      const firstOther = states.findIndex((state) => state !== 'LISTEN');
      assert(firstOther >= 0, 'UDP and connection-only groups remain visible');
      assert(states.slice(0, firstOther).length > 0, 'listeners are visible');
      assert(
        states.slice(firstOther).every((state) => state !== 'LISTEN'),
        'listeners precede other rows',
      );
    };
    await viewer.locator('tr[data-port-focused]').first().waitFor();
    await assertListenersFirst();
    // The filter also matches substrings of other processes' ports, PIDs, and commands.
    const ownPortRow = (port: number) =>
      viewer.locator('tr[data-port-focused]').filter({
        has: page.getByRole('button', { name: new RegExp(`connections for port ${port}, PID ${process.pid}$`) }),
      });
    await page.keyboard.press('/');
    await page.keyboard.type(String(tcpPort));
    const tcpRow = ownPortRow(tcpPort);
    await tcpRow.click();
    assert.equal(await tcpRow.count(), 1, 'listener and connections share one port/PID row');
    assert.equal(await tcpRow.locator('td').nth(3).innerText(), 'LISTEN');
    const details = viewer.getByRole('table', { name: `Connections for port ${tcpPort}, PID ${process.pid}` });
    assert.equal(await details.count(), 0, 'connection details are collapsed initially');
    await viewer
      .getByRole('button', { name: `Show connections for port ${tcpPort}, PID ${process.pid}`, exact: true })
      .click();
    await details.waitFor();
    assert.equal(await details.getByRole('row').count(), 4, 'listener plus two accepted connections');
    assert.equal(await details.getByText('ESTABLISHED', { exact: true }).count(), 2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('h');
    await details.waitFor({ state: 'detached' });
    await page.keyboard.press('Enter');
    await details.waitFor();
    await page.keyboard.press('Tab');
    await details.waitFor({ state: 'detached' });
    await page.keyboard.press('/');
    await page.keyboard.type(String(tcpPort));
    await page.keyboard.press('p');
    assert.equal(await viewer.getByText('Ports', { exact: true }).count(), 1, 'p is text while filtering');
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await page.keyboard.type(String(process.pid));
    await page.waitForFunction(() => document.querySelectorAll('tr[data-port-focused]').length >= 2);
    await page.keyboard.press('ArrowUp');
    const focusedKey = await page.evaluate(async () => {
      const { useProcessStore } = await import('/src/state/processStore.ts' as string);
      return useProcessStore.getState().focusedPort;
    });
    await page.keyboard.press('ArrowDown');
    const nextKey = await page.evaluate(async () => {
      const { useProcessStore } = await import('/src/state/processStore.ts' as string);
      return useProcessStore.getState().focusedPort;
    });
    assert.notEqual(nextKey, focusedKey, 'navigation distinguishes sockets owned by one process');
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await viewer.getByText('sort: port ▲', { exact: true }).waitFor();
    await page.keyboard.press('s');
    await viewer.getByText('sort: protocol ▲', { exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'Sort by port', exact: true }).click();
    await viewer.getByText('sort: port ▲', { exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'Sort by listeners first', exact: true }).click();
    await viewer.getByText('sort: listeners first', { exact: true }).waitFor();
    await assertListenersFirst();
    await page.keyboard.press('/');
    await page.keyboard.type(String(udpPort));
    await ownPortRow(udpPort).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('x');
    await viewer.getByText('Terminate', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await viewer.getByRole('list', { name: 'Processes', exact: true }).waitFor();
    await waitForAsync(page, async () => {
      const { useProcessStore } = await import('/src/state/processStore.ts' as string);
      return useProcessStore.getState().snapshot?.ports === null;
    });
    await page.keyboard.press('p');
    await viewer.locator('tr[data-port-focused]').first().waitFor();

    const otherPage = await context.newPage();
    try {
      await otherPage.goto(`${url}/s/${encodeURIComponent(session.name)}`);
      await waitForAsync(
        otherPage,
        async (pane) => {
          const { useStore } = await import('/src/state/store.tsx' as string);
          return useStore.getState().terminals.has(pane);
        },
        pane,
      );
      await otherPage.evaluate(async (pane) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        useStore.getState().setFileBrowserOpen(true, null, pane, 'process');
      }, pane);
      const otherViewer = otherPage.getByRole('dialog', { name: 'Processes', exact: true });
      await otherViewer.getByRole('list', { name: 'Processes', exact: true }).waitFor();
      await waitForAsync(otherPage, async () => {
        const { useProcessStore } = await import('/src/state/processStore.ts' as string);
        return useProcessStore.getState().snapshot?.ports === null;
      });
      await page.evaluate(() => {
        const sockets = (window as any).processTestSockets;
        sockets.at(-1).close();
      });
      await waitForAsync(page, async () => {
        const { useProcessStore } = await import('/src/state/processStore.ts' as string);
        const sockets = (window as any).processTestSockets;
        return sockets.length >= 2 && sockets.at(-1).readyState === 1 && useProcessStore.getState().snapshot?.ports;
      });
      assert.deepEqual(
        await page.evaluate(() => (window as any).processTestCommands.at(-1)),
        { type: 'set_ports', enabled: true },
        'reconnect restores ports subscription',
      );
      await otherPage.keyboard.press('p');
      await otherViewer.locator('tr[data-port-focused]').first().waitFor();
      await otherPage.keyboard.press('p');
      await otherViewer.getByRole('list', { name: 'Processes', exact: true }).waitFor();
      await waitForAsync(otherPage, async () => {
        const { useProcessStore } = await import('/src/state/processStore.ts' as string);
        return useProcessStore.getState().snapshot?.ports === null;
      });
      const sample = await page.evaluate(async () => {
        const { useProcessStore } = await import('/src/state/processStore.ts' as string);
        return useProcessStore.getState().snapshot;
      });
      await waitForAsync(
        page,
        async (previous) => {
          const { useProcessStore } = await import('/src/state/processStore.ts' as string);
          const current = useProcessStore.getState().snapshot;
          return current?.ports && JSON.stringify(current) !== JSON.stringify(previous);
        },
        sample,
      );
      console.log('PASS process socket reconnect restores ports and viewers toggle independently');
    } finally {
      await otherPage.close();
    }
    await page.keyboard.press('q');
    await viewer.waitFor({ state: 'detached' });
    console.log('PASS grouped ports, connection expansion, process/port toggle, filtering, navigation and sorting');
  } finally {
    for (const client of portClients) client.destroy();
    portListener.close();
    udpSocket.close();
  }

  const unavailablePage = await context.newPage();
  const unavailableCommands: Array<{ type: string }> = [];
  await unavailablePage.routeWebSocket(/\/ws\/processes$/, (socket) => {
    const snapshot = {
      type: 'snapshot',
      processes: [],
      ports: null,
      ports_error: null,
      cpu_count: 1,
      mem_used: 0,
      mem_total: 0,
      load_average: [0, 0, 0],
    };
    socket.send(JSON.stringify(snapshot));
    socket.onMessage((message) => {
      const command = JSON.parse(String(message));
      unavailableCommands.push(command);
      if (command.type === 'set_ports') {
        const port = {
          pid: null,
          protocol: 'TCP',
          local_address: '127.0.0.1',
          local_port: 62222,
          remote_address: null,
          state: 'LISTEN',
        };
        socket.send(
          JSON.stringify({
            ...snapshot,
            ports: command.enabled
              ? [
                  port,
                  { ...port, local_address: '::1' },
                  { ...port, protocol: 'UDP', state: 'BOUND' },
                  { ...port, pid: 99 },
                ]
              : null,
          }),
        );
      }
    });
  });
  try {
    await unavailablePage.goto(`${url}/s/${encodeURIComponent(session.name)}`);
    await waitForAsync(
      unavailablePage,
      async (pane) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        return useStore.getState().terminals.has(pane);
      },
      pane,
    );
    await unavailablePage.evaluate(async (pane) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, null, pane, 'process');
    }, pane);
    const viewer = unavailablePage.getByRole('dialog', { name: 'Processes', exact: true });
    await viewer.getByText('No processes', { exact: true }).waitFor();
    await unavailablePage.keyboard.press('p');
    await viewer.locator('tr[data-port-focused]').first().waitFor();
    assert.equal(await viewer.locator('tr[data-port-focused]').count(), 4);
    assert.equal(await viewer.getByText('Unknown owner', { exact: true }).count(), 3);
    await viewer.getByText('4', { exact: true }).waitFor();
    for (const label of ['Unknown owner', 'Process unavailable']) {
      // Click its protocol cell: the feedback toasts stack over the right side.
      await viewer
        .locator('tr', { hasText: label })
        .first()
        .locator('td')
        .nth(1)
        .click();
      for (const key of ['x', 'X']) {
        const toasts = unavailablePage.locator('.astryx-toast', {
          hasText: 'Cannot signal this socket: process information is unavailable',
        });
        const shown = await toasts.count();
        await unavailablePage.keyboard.press(key);
        await waitForAsync(
          unavailablePage,
          (shown) =>
            [...document.querySelectorAll('.astryx-toast')].filter((toast) =>
              toast.textContent?.includes('Cannot signal this socket: process information is unavailable'),
            ).length > shown,
          shown,
        );
      }
    }
    assert(
      unavailableCommands.every((command) => command.type !== 'kill'),
      'unavailable owners cannot be signaled',
    );
    console.log('PASS unknown endpoint grouping, header count and unavailable process signal feedback');
  } finally {
    await unavailablePage.close();
  }

  const toastIsOnTop = async (message: string) => {
    await page.waitForFunction((message) => {
      const toast = [...document.querySelectorAll('.astryx-toast')].find((toast) =>
        toast.textContent?.includes(message),
      );
      const button = toast?.querySelector('button[aria-label="Dismiss notification"]');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }, message);
  };
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().showToast('Toast before settings', 'error');
  });
  await toastIsOnTop('Toast before settings');
  const settings = page.getByRole('button', { name: 'Settings', exact: true }).first();
  await settings.click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const spacing = await dialog.getByRole('tabpanel').evaluate((panel) => {
    const dialog = panel.closest('dialog')!;
    return panel.getBoundingClientRect().left - dialog.getBoundingClientRect().left;
  });
  assert(spacing >= 16, 'settings groups must retain Astryx container padding');
  await toastIsOnTop('Toast before settings');
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().showToast('Toast in settings');
  });
  await toastIsOnTop('Toast in settings');
  await page
    .locator('.astryx-toast')
    .filter({ hasText: 'Toast in settings' })
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  await page.locator('.astryx-toast').filter({ hasText: 'Toast in settings' }).waitFor({ state: 'detached' });
  await dialog.getByRole('heading', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.closest('dialog')?.open));
  await page.keyboard.press('Escape');
  if (await dialog.count()) await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.activeElement !== document.body && !document.activeElement?.closest('dialog'),
  );
  assert(
    await page.evaluate(async (id) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().terminals.get(id) === (window as any).astryxTestTerminal;
    }, pane),
    'opening settings must preserve the terminal',
  );
  await toastIsOnTop('Toast before settings');

  await settings.click();
  await dialog.getByRole('tab', { name: 'Wallpaper', exact: true }).click();
  const wallpaper = dialog.getByRole('textbox', { name: 'Wallpaper URL or path', exact: true });
  const wallpaperStatus = async (value: string, status: string, message?: string) => {
    await wallpaper.fill(value);
    await wallpaper.locator(`xpath=parent::*[@data-status="${status}"]`).waitFor();
    if (message) await dialog.getByText(message, { exact: true }).waitFor();
  };
  await wallpaperStatus(path.join(repo, 'missing.png'), 'error', 'File not found');
  await wallpaperStatus(path.join(repo, 'README'), 'error', 'Not an image file');
  writeFileSync(path.join(repo, 'bg.png'), 'PNG!');
  await wallpaperStatus(path.join(repo, 'bg.png'), 'success');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  console.log('PASS debounced wallpaper validation');

  await settings.click();
  const shellField = dialog.getByRole('combobox', { name: 'Shell for new panes', exact: true });
  // The stack runs `btmux --shell /bin/sh`, which the setting can't change.
  await shellField.filter({ hasText: '/bin/sh' }).waitFor();
  assert.equal(await shellField.getAttribute('aria-disabled'), 'true');
  const setCliShell = (shell: string | null) =>
    page.evaluate(async (shell) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.setState((state: any) => ({ config: { ...state.config, cli_shell: shell } }));
    }, shell);
  await setCliShell(null);
  const shells = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().config.shells as { label: string; command: string }[];
  });
  assert(shells.length > 0, 'settings must list installed shells');
  await shellField.filter({ hasText: 'Default (' }).waitFor();
  const shellCommand = dialog.getByRole('textbox', { name: 'Shell command', exact: true });
  await shellField.click();
  await page.getByRole('option').filter({ hasText: shells[0].command }).first().click();
  await shellField.filter({ hasText: shells[0].label }).waitFor();
  assert.equal(await shellCommand.count(), 0, 'a listed shell needs no command field');
  await shellField.click();
  await page.getByRole('option', { name: 'Custom…', exact: true }).click();
  assert.equal(await shellCommand.inputValue(), shells[0].command);
  await shellCommand.fill('/bin/sh -l');
  await page.keyboard.press('Escape');
  if (await dialog.count()) await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await setCliShell('/bin/sh');
  console.log('PASS shell selection');

  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await toastIsOnTop('Toast before settings');
  const confirmationLabel = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().config.commands.find((command: any) => command.confirm).label;
  });
  await page.locator('dialog[open] input').fill(confirmationLabel);
  await page.locator('dialog[open]').getByText(confirmationLabel, { exact: true }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await toastIsOnTop('Toast before settings');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page
    .locator('.astryx-toast')
    .filter({ hasText: 'Toast before settings' })
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  console.log('PASS toast stacking and interaction across modal transitions');

  // Typing that keeps the same results must keep the top one highlighted
  // ("ab" also matches "about: system info").
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const aboutHighlighted = () =>
    page.waitForFunction(() => {
      const options = document.querySelectorAll('dialog[open] [role="option"]');
      const active = document.querySelector('dialog[open] input')?.getAttribute('aria-activedescendant');
      return (
        options.length === 2 &&
        options[0].getAttribute('data-value') === 'about' &&
        options[1].getAttribute('data-value') === 'system-info' &&
        options[0].id === active
      );
    });
  await page.keyboard.type('ab');
  await aboutHighlighted();
  await page.keyboard.type('o');
  await aboutHighlighted();
  await page.keyboard.press('Backspace');
  await aboutHighlighted();
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  console.log('PASS command palette keeps the top result highlighted');

  // Ctrl-N/P cycle through the filtered results.
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.keyboard.type('window');
  const waitForHighlight = (index: number) =>
    page.waitForFunction((index) => {
      const options = [...document.querySelectorAll('dialog[open] [role="option"]')];
      const active = document.querySelector('dialog[open] input')?.getAttribute('aria-activedescendant');
      return options.length > 1 && options.findIndex((option) => option.id === active) === index;
    }, index);
  await waitForHighlight(0);
  const windowCount = await page.locator('dialog[open] [role="option"]').count();
  await page.keyboard.press('Control+n');
  await waitForHighlight(1);
  await page.keyboard.press('Control+p');
  await waitForHighlight(0);
  await page.keyboard.press('Control+p');
  await waitForHighlight(windowCount - 1);
  await page.keyboard.press('Control+n');
  await waitForHighlight(0);
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  console.log('PASS command palette cycles results with Ctrl-N/P');

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    state.setOverlay({
      mode: 'picker',
      title: 'Test font picker',
      items: [
        { id: 'one', label: 'First font', active: true },
        { id: 'two', label: 'Second font' },
      ],
      onSelect: (id: string) => {
        (window as any).astryxPicked = id;
      },
    });
  });
  await page.getByRole('heading', { name: 'Test font picker' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => (window as any).astryxPicked), 'two');
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (window as any).astryxPicked), 'one');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });

  console.log('PASS Astryx forms, command confirmation, and picker');

  // Enter in the new-session prompt must not reach the pane it refocuses.
  await page.evaluate(() => ((window as any).paneTestInput = ''));
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Name' }).fill(`prompt-${Date.now()}`);
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => (window as any).paneTestInput), '');
  console.log('PASS prompt Enter stays out of the pane');
  await page.getByRole('button', { name: 'Window overview', exact: true }).first().click();
  await page.locator('dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });

  // Clicking a file focuses it, like moving to it with the keyboard.
  writeFileSync(path.join(repo, 'zz-clicked.txt'), 'clicked\n');
  await page.evaluate(
    async ({ id, path }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, path, id, 'files');
    },
    { id: pane, path: repo },
  );
  const clicked = page.locator('[data-index]', { hasText: 'zz-clicked.txt' });
  assert.doesNotMatch((await clicked.getAttribute('class')) ?? '', /\bbg-accent-bg\b/);
  await clicked.click();
  await page.getByText('clicked', { exact: true }).waitFor();
  assert.match((await clicked.getAttribute('class')) ?? '', /\bbg-accent-bg\b/);
  // A selection ends with the browser.
  await page.keyboard.press(' ');
  await page.getByText('1 selected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close file browser' }).click();
  await page.getByRole('button', { name: 'Close file browser' }).waitFor({ state: 'hidden' });
  const selected = await page.evaluate(async () => {
    const { useFileStore } = await import('/src/state/fileStore.ts' as string);
    return useFileStore.getState().selectedPaths.size;
  });
  assert.equal(selected, 0);
  console.log('PASS file click moves focus; selection clears on close');

  await page.evaluate(
    async ({ id, path }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, path, id, 'git');
    },
    { id: pane, path: repo },
  );
  await page.getByText('main', { exact: true }).first().waitFor();
  assert.equal(await page.getByText(/selected$/).count(), 0);
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().showToast('Toast in Git browser', 'error');
  });
  await toastIsOnTop('Toast in Git browser');
  await page
    .getByRole('button', { name: 'Close file browser' })
    .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());
  await page.keyboard.press('c');
  await page.getByRole('heading', { name: 'Commit staged changes' }).waitFor();
  await toastIsOnTop('Toast in Git browser');
  await page.getByRole('textbox', { name: /^Subject/ }).pressSequentially('q rename c');
  await page.getByRole('textbox', { name: /^Body/ }).fill('Draft only.');
  assert.equal(await page.getByRole('textbox', { name: /^Subject/ }).inputValue(), 'q rename c');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Commit staged changes', exact: true }).waitFor({ state: 'hidden' });
  await toastIsOnTop('Toast in Git browser');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close file browser' }).waitFor({ state: 'hidden' });
  await toastIsOnTop('Toast in Git browser');
  await page
    .locator('.astryx-toast')
    .filter({ hasText: 'Toast in Git browser' })
    .getByRole('button', { name: 'Dismiss notification' })
    .click();

  console.log('PASS Git commit dialog input isolation');
  // Live theme changes must update both terminal and UI, including light mode.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    (window as any).astryxOriginalConfig = state.config;
    state.setConfig({
      ...state.config,
      theme: { ...state.config.theme, background: '#f4f4f4', foreground: '#202020' },
      terminal: { ...state.config.terminal, fontFamily: 'Fira Code' },
    });
  });
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'light' &&
      getComputedStyle(document.querySelector('.btm-mono')!).fontFamily.includes('Fira Code') &&
      getComputedStyle(document.body).fontFamily.includes('Geist Variable'),
  );
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setConfig((window as any).astryxOriginalConfig);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'compact shell must not overflow horizontally',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const compact = await page.locator('dialog[open]').boundingBox();
  assert(compact && compact.x >= 0 && compact.width <= 390);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    'PASS Astryx colors, typography, modal focus, command confirmation, picker, overview, and compact layout',
  );
} finally {
  await browser.close();
  rmSync(repo, { recursive: true, force: true });
  const removed = await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  assert(removed.ok);
}
