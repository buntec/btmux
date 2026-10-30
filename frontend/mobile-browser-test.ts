/** Touch-device regressions (key bar, swipes, narrow layout) in WebKit with iPhone emulation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { devices, webkit, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const api = (path: string, init: RequestInit = {}) =>
  fetch(url + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

async function sessionWindows(): Promise<{ zoomed_pane: string | null }[]> {
  const [session] = await (await api('/api/sessions')).json();
  return (await (await api(`/api/sessions/${session.id}`)).json()).windows;
}

async function connect(page: Page) {
  await page.goto(url);
  await page.getByLabel('Access token').fill(token!);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
}

// Records the active pane's input bytes as a string.
async function recordInput(page: Page) {
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    const session = state.allSessions[0];
    const term = state.terminals.get(state.getActivePaneId(session.id));
    const record = window as unknown as { input: string; term: unknown };
    record.input = '';
    record.term = term;
    term.onData((bytes: Uint8Array) => (record.input += new TextDecoder().decode(bytes)));
  });
}

async function takeInput(page: Page) {
  return page.evaluate(() => {
    const record = window as unknown as { input: string };
    const input = record.input;
    record.input = '';
    return input;
  });
}

async function write(page: Page, data: string) {
  await page.evaluate((data) => {
    (window as unknown as { term: { write(data: string): void } }).term.write(data);
  }, data);
}

const browser = await webkit.launch({ headless: true });
try {
  const desktop = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await connect(desktop);
  assert.equal(await desktop.getByRole('button', { name: 'Esc', exact: true }).count(), 0);
  await desktop.close();

  const context = await browser.newContext({ ...devices['iPhone 15'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await connect(page);
  const keys = (name: string) => page.getByRole('button', { name, exact: true });
  await keys('Esc').waitFor();

  // The app fits the visual viewport.
  const fit = await page.evaluate(() => ({
    root: document.getElementById('root')!.getBoundingClientRect().height,
    viewport: window.visualViewport!.height,
  }));
  assert.equal(Math.round(fit.root), Math.round(fit.viewport));
  // The key bar stays above the keyboard, which shrinks the visual viewport.
  const setViewportHeight = (height: string) =>
    page.evaluate((height) => document.documentElement.style.setProperty('--btm-viewport-height', height), height);
  await setViewportHeight('300px');
  const hide = (await keys('Hide keyboard').boundingBox())!;
  assert(hide.y + hide.height <= 300, `key bar ends at ${hide.y + hide.height}px`);
  await setViewportHeight(`${fit.viewport}px`);

  // Taps keep the terminal focused, so the keyboard stays open.
  await recordInput(page);
  await page.getByLabel('Terminal').first().tap();
  const focusedInput = () => page.evaluate(() => document.activeElement?.closest('[data-pane-terminal]') !== null);
  assert(await focusedInput());
  await keys('Esc').tap();
  await keys('Tab').tap();
  await keys('Up').tap();
  assert(await focusedInput());
  // Escape then Tab would leave the terminal; the key bar's Tab reaches it.
  assert.equal(await takeInput(page), '\x1b\t\x1b[A');

  // Ctrl and Alt apply once, to a key-bar key or the next typed key.
  await keys('Ctrl').tap();
  assert.equal(await keys('Ctrl').getAttribute('aria-pressed'), 'true');
  await page.keyboard.type('c');
  await keys('Alt').tap();
  await keys('Left').tap();
  await page.keyboard.type('x');
  assert.equal(await takeInput(page), '\x03\x1b[1;3Dx');
  assert.equal(await keys('Ctrl').getAttribute('aria-pressed'), 'false');

  // Keys go through wterm's encoder, including the kitty keyboard protocol.
  await write(page, '\x1b[>1u');
  await keys('Esc').tap();
  await write(page, '\x1b[<u');
  assert.equal(await takeInput(page), '\x1b[27u');

  // Swipes scroll full-screen applications like the wheel.
  await write(page, '\x1b[?1049h');
  await page.evaluate(() => {
    const element = document.querySelector('[data-pane-terminal]')!;
    const rect = element.getBoundingClientRect();
    // WebKit only constructs Touch on iOS; the handlers read clientX/Y.
    const send = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = type === 'touchend' ? [] : [{ identifier: 1, clientX: rect.left + 50, clientY: y }];
      Object.defineProperty(event, 'touches', { value: touches });
      element.dispatchEvent(event);
    };
    send('touchstart', rect.top + 300);
    for (let y = rect.top + 290; y >= rect.top + 200; y -= 10) send('touchmove', y);
    send('touchend', rect.top + 200);
  });
  const scrolled = await takeInput(page);
  assert.match(scrolled, /^(\x1b\[B)+$/);
  await write(page, '\x1b[?1049l');

  // The prefix button arms btmux's prefix for the next typed key.
  const windows = async () => (await sessionWindows()).length;
  const before = await windows();
  await page.getByRole('button', { name: /^Prefix/ }).tap();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().prefixActive;
  });
  await page.keyboard.type('c');
  for (let i = 0; i < 50 && (await windows()) === before; i++) await page.waitForTimeout(100);
  assert.equal(await windows(), before + 1);

  // Narrow screens show only the active pane; Next pane cycles them.
  const panes = await (await api('/api/panes')).json();
  const paneId = panes.find((pane: { window_active: boolean; pane_active: boolean }) => pane.window_active && pane.pane_active).pane_id;
  assert((await api(`/api/panes/${paneId}/split`, { method: 'POST', body: '{"direction":"right"}' })).ok);
  await keys('Next pane').waitFor();
  const shown = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('[data-pane-terminal]')].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && element.checkVisibility();
        }).length,
    );
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size >= 3;
  });
  assert.equal(await shown(), 1);
  const activePane = () =>
    page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      return state.getActivePaneId(state.allSessions[0].id);
    });
  const first = await activePane();
  await keys('Next pane').tap();
  await waitForAsync(page, async (first) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    return state.getActivePaneId(state.allSessions[0].id) !== first;
  }, first);
  assert.equal(await shown(), 1);
  const zoomed = (await sessionWindows()).some((window) => window.zoomed_pane);
  assert(!zoomed, 'the narrow layout must not zoom on the server');

  // File browser hints type their keys when tapped.
  const dir = mkdtempSync(path.join(tmpdir(), 'btmux-mobile-'));
  mkdirSync(path.join(dir, 'a-dir'));
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  writeFileSync(path.join(dir, '.hidden'), '');
  await page.evaluate(async (dir) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    state.setFileBrowserOpen(true, dir, state.getActivePaneId(state.allSessions[0].id), 'files');
  }, dir);
  const row = (name: string) => page.locator('[data-index]', { hasText: name });
  await row('b.txt').waitFor();
  await page.getByRole('button', { name: 'G: top/bottom', exact: true }).tap();
  await waitForAsync(page, async () =>
    /\bbg-accent-bg\b/.test(document.querySelector('[data-index="1"]')?.className ?? ''),
  );
  assert.match((await row('b.txt').getAttribute('class')) ?? '', /\bbg-accent-bg\b/);
  await page.getByRole('button', { name: '.: dotfiles', exact: true }).tap();
  await row('.hidden').waitFor();
  // Narrow screens fill the screen, keep the path on one line, and show the
  // list or, after a tap, the preview.
  const layout = await page.evaluate(() => {
    const items = [...document.querySelectorAll('nav[aria-label="Current directory"] li')];
    return {
      dialog: document.querySelector('dialog[open]')!.getBoundingClientRect().height,
      viewport: window.visualViewport!.height,
      // Items differ in size, so compare their spread to their height.
      crumbSpread:
        Math.max(...items.map((item) => item.getBoundingClientRect().top)) -
        Math.min(...items.map((item) => item.getBoundingClientRect().top)),
      crumbHeight: Math.min(...items.map((item) => item.getBoundingClientRect().height)),
    };
  });
  assert.equal(Math.round(layout.dialog), Math.round(layout.viewport));
  assert(layout.crumbSpread < layout.crumbHeight / 2, 'the path wraps');
  await row('b.txt').tap();
  const back = page.getByRole('button', { name: 'Back to list' });
  await back.waitFor();
  assert(!(await row('b.txt').isVisible()));
  await page.getByRole('button', { name: 'esc: close', exact: true }).tap();
  await row('b.txt').waitFor();
  assert(!(await back.isVisible()));
  await row('b.txt').tap();
  await back.tap();
  await row('b.txt').waitFor();
  await page.getByRole('button', { name: 'esc: close', exact: true }).tap();
  await page.getByRole('button', { name: 'Close file browser' }).waitFor({ state: 'hidden' });

  // Tapping a Git section header folds it.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await page.evaluate(async (dir) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    state.setFileBrowserOpen(true, dir, state.getActivePaneId(state.allSessions[0].id), 'git');
  }, dir);
  const untracked = page.locator('[data-git-index]', { hasText: 'b.txt' });
  await untracked.waitFor();
  await page.getByText('UNTRACKED FILES', { exact: true }).tap();
  await untracked.waitFor({ state: 'detached' });
  await page.getByText('UNTRACKED FILES', { exact: true }).tap();
  await untracked.waitFor();
  // Filters take text through an input, focused by the tap so the keyboard opens.
  await page.getByRole('button', { name: '/: filter', exact: true }).tap();
  const filter = page.getByRole('textbox', { name: 'Filter' });
  assert(await filter.evaluate((input) => input === document.activeElement));
  await page.keyboard.type('zz');
  await untracked.waitFor({ state: 'detached' });
  assert.equal(await filter.inputValue(), 'zz');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await untracked.waitFor();
  await page.getByRole('button', { name: 'esc: close filter', exact: true }).tap();
  await filter.waitFor({ state: 'detached' });
  // The browser keeps focus for its keys.
  assert(await page.evaluate(() => document.activeElement?.closest('dialog') !== null));
  await page.getByRole('button', { name: 'Close file browser' }).tap();
  await page.getByRole('button', { name: 'Close file browser' }).waitFor({ state: 'hidden' });
  rmSync(dir, { recursive: true, force: true });

  // Installable: the manifest loads with the session cookie.
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest', { credentials: 'include' })).json());
  assert.equal(manifest.display, 'standalone');

  assert.deepEqual(errors, []);
  console.log('PASS mobile key bar, sticky modifiers, kitty encoding, swipes, prefix, narrow layout, viewport, and manifest');
} finally {
  await browser.close();
}
