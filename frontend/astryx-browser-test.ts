/** Run against an isolated dev stack: BTMUX_AUTH_TOKEN=... bun astryx-browser-test.ts */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULT_THEME } from './src/state/defaultTheme';

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
    ...DEFAULT_THEME,
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    const { DEFAULT_THEME } = await import('/src/state/defaultTheme.ts' as string);
    const { getTerminalFontFamily } = await import('/src/state/configDefaults.ts' as string);
    const css = getComputedStyle(document.body);
    return {
      background: css.getPropertyValue('--color-background-body').trim(),
      palette: (config.theme ?? DEFAULT_THEME).background,
      font: css.fontFamily,
      terminalFont: getTerminalFontFamily(config),
    };
  });
  assert.equal(theme.background, theme.palette);
  assert(theme.font.includes(theme.terminalFont));

  const settings = page.getByRole('button', { name: 'Settings', exact: true }).first();
  await settings.click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const spacing = await dialog.getByRole('heading', { name: 'General', exact: true }).evaluate((heading) => {
    const dialog = heading.closest('dialog')!;
    return heading.getBoundingClientRect().left - dialog.getBoundingClientRect().left;
  });
  assert(spacing >= 16, 'settings groups must retain Astryx container padding');
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

  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const confirmationLabel = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().config.commands.find((command: any) => command.confirm).label;
  });
  await page.locator('dialog[open] input').fill(confirmationLabel);
  await page.locator('dialog[open]').getByText(confirmationLabel, { exact: true }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });

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
  await page
    .getByRole('button', { name: 'Close file browser' })
    .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());
  await page.keyboard.press('c');
  await page.getByRole('heading', { name: 'Commit staged changes' }).waitFor();
  await page.getByRole('textbox', { name: /^Subject/ }).pressSequentially('q rename c');
  await page.getByRole('textbox', { name: /^Body/ }).fill('Draft only.');
  assert.equal(await page.getByRole('textbox', { name: /^Subject/ }).inputValue(), 'q rename c');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Close file browser' }).click();

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
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
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
