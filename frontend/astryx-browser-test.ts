/** Run against an isolated dev stack: BTMUX_AUTH_TOKEN=... bun astryx-browser-test.ts */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createConnection, createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { FALLBACK_THEME } from './src/state/startupTheme';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
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
  await startup.addInitScript((theme) => localStorage.setItem('btmux-theme', JSON.stringify(theme)), {
    ...FALLBACK_THEME,
    background: '#273549',
  });
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
  await page.waitForFunction(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const term = useStore.getState().terminals.get(id);
    if (!term || !useStore.getState().config) return false;
    (window as any).astryxTestTerminal = term;
    return true;
  }, pane);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const theme = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const config = useStore.getState().config;
    const { getTerminalFontFamily } = await import('/src/state/configDefaults.ts' as string);
    const css = getComputedStyle(document.body);
    return {
      background: css.getPropertyValue('--color-background-body').trim(),
      palette: config.theme.background,
      font: css.fontFamily,
      terminalFont: getTerminalFontFamily(config),
    };
  });
  assert.equal(theme.background, theme.palette);
  assert(theme.font.includes(theme.terminalFont));

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
    await page.waitForFunction(
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
    await page.keyboard.press('/');
    await page.keyboard.type(String(tcpPort));
    const tcpRow = viewer.locator('tr[data-port-focused]').filter({ hasText: 'LISTEN' });
    await tcpRow.first().click();
    assert((await tcpRow.first().innerText()).includes(String(process.pid)));
    assert.equal(await tcpRow.count(), 1, 'listener and connections share one port/PID row');
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
    await viewer.getByText('sort: protocol', { exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'Sort by port', exact: true }).click();
    await viewer.getByText('sort: port', { exact: true }).waitFor();
    await page.keyboard.press('/');
    await page.keyboard.type(String(udpPort));
    await viewer.locator('tr[data-port-focused]').filter({ hasText: 'UDP' }).first().click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('x');
    await viewer.getByText('Terminate', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await viewer.getByRole('list', { name: 'Processes', exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const { useProcessStore } = await import('/src/state/processStore.ts' as string);
      return useProcessStore.getState().snapshot?.ports === null;
    });
    await page.keyboard.press('p');
    await viewer.locator('tr[data-port-focused]').first().waitFor();
    await page.keyboard.press('q');
    await viewer.waitFor({ state: 'detached' });
    console.log('PASS grouped ports, connection expansion, process/port toggle, filtering, navigation and sorting');
  } finally {
    for (const client of portClients) client.destroy();
    portListener.close();
    udpSocket.close();
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
  await dialog.getByRole('button', { name: 'Copy TOML', exact: true }).click();
  await toastIsOnTop('Settings copied to clipboard');
  await page
    .locator('.astryx-toast')
    .filter({ hasText: 'Settings copied to clipboard' })
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  await page
    .locator('.astryx-toast')
    .filter({ hasText: 'Settings copied to clipboard' })
    .waitFor({ state: 'detached' });
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
  await page.getByRole('button', { name: 'Window overview', exact: true }).first().click();
  await page.locator('dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });

  await page.evaluate(
    async ({ id, path }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, path, id, 'git');
    },
    { id: pane, path: fileURLToPath(new URL('..', import.meta.url)) },
  );
  const branch =
    execFileSync('git', ['branch', '--show-current'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    }).trim() || 'detached';
  await page.getByText(branch, { exact: true }).first().waitFor();
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
      getComputedStyle(document.body).fontFamily.includes('Fira Code'),
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
  const removed = await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  assert(removed.ok);
}
