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

  // The tailnet popover's QR code signs a phone in once, without the token.
  await desktop.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setTailscale({ state: 'serving', url: location.origin });
  });
  let pairRequests = 0;
  desktop.on('request', (request) => request.url().endsWith('/api/pair') && pairRequests++);
  await desktop.getByRole('button', { name: 'Tailnet', exact: true }).waitFor();
  assert.equal(pairRequests, 0);
  const issued = desktop.waitForResponse((response) => response.url().endsWith('/api/pair'));
  await desktop.getByRole('button', { name: 'Tailnet', exact: true }).click();
  const { code } = await (await issued).json();
  await desktop.locator('svg.bg-white path').waitFor();
  await desktop.close();
  const pairing = await browser.newContext({ ...devices['iPhone 15'] });
  const paired = await pairing.newPage();
  await paired.goto(`${url}/pair?code=${code}`);
  await waitForAsync(paired, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  assert.equal((await paired.goto(`${url}/pair?code=${code}`))!.status(), 401);
  await pairing.close();

  // A link from another site (a web QR scanner) signs in too: SameSite=Strict
  // withholds the cookie from a redirect that continues that navigation.
  const backend = process.env.BTMUX_TEST_BACKEND_URL ?? 'http://127.0.0.1:8044';
  const { code: linked } = await (
    await fetch(`${backend}/api/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const scanning = await browser.newContext({ ...devices['iPhone 15'] });
  const scanner = await scanning.newPage();
  await scanner.route('https://scanner.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<a href="${backend}/pair?code=${linked}">open</a>` }),
  );
  await scanner.goto('https://scanner.test/');
  const app = scanner.waitForResponse((response) => response.url() === `${backend}/`);
  await scanner.getByRole('link', { name: 'open' }).click();
  assert.equal((await app).status(), 200);
  await scanning.close();

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
  // Also to text that keyboards send without key events (Android) or compose.
  await keys('Ctrl').tap();
  await page.keyboard.insertText('c');
  await keys('Ctrl').tap();
  await page.evaluate(() => {
    const input = document.activeElement as HTMLTextAreaElement;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'e';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'e' }));
  });
  // Longer text, like a suggestion, goes through and disarms them.
  await keys('Ctrl').tap();
  await page.keyboard.insertText('cat');
  assert.equal(await takeInput(page), '\x03\x05cat');
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
  // Also when the key arrives as text after an unidentified key (Android).
  // The new window's pane takes focus once its replay is shown.
  await page.waitForFunction(() => document.activeElement?.closest('[data-pane-terminal]') != null);
  await page.getByRole('button', { name: /^Prefix/ }).tap();
  // Armed only once the key bar has rendered it.
  await page.getByRole('button', { name: /^Prefix/, pressed: true }).waitFor();
  await page.evaluate(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }),
    ),
  );
  await page.keyboard.insertText('c');
  for (let i = 0; i < 50 && (await windows()) === before + 1; i++) await page.waitForTimeout(100);
  assert.equal(await windows(), before + 2);
  // Tapping it again disarms it rather than sending the prefix.
  await page.evaluate(() => {
    const record = window as unknown as { sent: string[] };
    const send = WebSocket.prototype.send;
    record.sent = [];
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') record.sent.push(data);
      return send.call(this, data);
    };
  });
  await page.getByRole('button', { name: /^Prefix/, pressed: false }).tap();
  await page.getByRole('button', { name: /^Prefix/, pressed: true }).tap();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return !useStore.getState().prefixActive;
  });
  const sent = await page.evaluate(() => (window as unknown as { sent: string[] }).sent);
  assert(!sent.some((message) => message.includes('write_pane_input')), 'the prefix was sent');

  // Narrow screens show only the active pane; Next pane cycles them.
  const panes = await (await api('/api/panes')).json();
  const paneId = panes.find(
    (pane: { window_active: boolean; pane_active: boolean }) => pane.window_active && pane.pane_active,
  ).pane_id;
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
  await waitForAsync(
    page,
    async (first) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      return state.getActivePaneId(state.allSessions[0].id) !== first;
    },
    first,
  );
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
  // A hint that opens a text field focuses it during the tap, so the keyboard
  // opens; search results open their preview when tapped.
  const focusedInTap = await page.getByRole('button', { name: 'f: search', exact: true }).evaluate((button) => {
    (button as HTMLElement).click();
    return document.activeElement?.tagName;
  });
  assert.equal(focusedInTap, 'INPUT');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await page.keyboard.type('b.t');
  const result = page.getByLabel('Search results').locator('[data-index]', { hasText: 'b.txt' });
  await result.tap();
  await back.waitFor();
  await back.tap();
  await result.waitFor();
  await page.getByRole('button', { name: 'esc: exit search', exact: true }).tap();
  await search.waitFor({ state: 'detached' });
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

  // The process viewer: hints type their keys, the list or a row's details fill
  // the screen, and the filter takes text through an input.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    state.setFileBrowserOpen(true, null, state.getActivePaneId(state.allSessions[0].id), 'process');
  });
  const processRow = page.locator('[data-process-pid]').first();
  await processRow.waitFor();
  assert.equal(await page.getByRole('button', { name: 'USER', exact: true }).count(), 0);
  // Keys of a multi-key hint are padded to a usable size.
  const keyBox = (await page.getByRole('button', { name: 'j: navigate', exact: true }).boundingBox())!;
  assert(keyBox.width >= 32 && keyBox.height >= 32, `small hint key: ${JSON.stringify(keyBox)}`);
  await page.getByRole('button', { name: 'V: tree', exact: true }).tap();
  await page.getByRole('tree', { name: 'Processes', exact: true }).waitFor();
  // At the PID: WebKit moves taps near the fold button onto it.
  await processRow.tap({ position: { x: 16, y: 8 } });
  const processBack = page.getByRole('button', { name: 'Back to list' });
  await processBack.waitFor();
  assert(!(await processRow.isVisible()));
  await page.getByRole('button', { name: 'esc: close', exact: true }).tap();
  await processRow.waitFor();
  await page.getByRole('button', { name: '/: filter', exact: true }).tap();
  const processFilter = page.getByRole('textbox', { name: 'Filter' });
  assert(await processFilter.evaluate((input) => input === document.activeElement));
  await page.keyboard.type('zzzzzz');
  await processRow.waitFor({ state: 'detached' });
  assert.equal(await processFilter.inputValue(), 'zzzzzz');
  await page.getByRole('button', { name: 'esc: close filter', exact: true }).tap();
  await processFilter.waitFor({ state: 'detached' });
  await processRow.waitFor();
  assert(await page.evaluate(() => document.activeElement?.closest('dialog') !== null));
  await page.getByRole('button', { name: 'Close process viewer' }).tap();
  await page.getByRole('button', { name: 'Close process viewer' }).waitFor({ state: 'hidden' });

  // Switcher hints type their keys, and tapping a window switches to it.
  const [firstSession] = await (await api('/api/sessions')).json();
  assert(
    (
      await api(`/api/sessions/${firstSession.id}/windows`, {
        method: 'POST',
        body: '{"name":"tapme","select":false}',
      })
    ).ok,
  );
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setSwitcherOpen(true);
  });
  const switcher = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await switcher.waitFor();
  await page.getByRole('button', { name: '/: filter', exact: true }).tap();
  const switcherFilter = page.getByRole('textbox', { name: 'Filter sessions' });
  assert(await switcherFilter.evaluate((input) => input === document.activeElement));
  await page.getByRole('button', { name: 'esc: close filter', exact: true }).tap();
  await switcherFilter.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'right: fold', exact: true }).tap();
  await switcher.getByText('tapme', { exact: true }).tap();
  await switcher.waitFor({ state: 'hidden' });
  await page.waitForURL(/\/w\/tapme$/);

  // Pane search opened before the replay keeps focus when the pane shows it,
  // and the key bar's Esc reaches it, not the shell.
  await page.reload();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    const paneId = state.allSessions[0] && state.getActivePaneId(state.allSessions[0].id);
    if (!paneId) return false;
    state.setSearchPaneId(paneId);
    return true;
  });
  const paneSearch = page.getByRole('textbox', { name: 'Search scrollback' });
  await paneSearch.waitFor();
  await waitForAsync(page, async () =>
    [...document.querySelectorAll('[data-pane-terminal]')].some(
      (element) => element.checkVisibility({ visibilityProperty: true }) && element.getBoundingClientRect().width > 0,
    ),
  );
  await page.waitForTimeout(300);
  assert(await paneSearch.evaluate((input) => input === document.activeElement), 'the replay took focus from search');
  // The key bar stays scrolled to where an earlier tap left it. WebKit targets
  // the scroller's pointerdown, so Playwright's tap refuses; touch the key itself.
  await keys('Esc').evaluate((key) => key.parentElement!.scrollTo({ left: 0, behavior: 'instant' }));
  const escBox = (await keys('Esc').boundingBox())!;
  await page.touchscreen.tap(escBox.x + escBox.width / 2, escBox.y + escBox.height / 2);
  await paneSearch.waitFor({ state: 'detached' });

  // Settings fill the screen, and a binding takes a key typed into an input.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setSettingsOpen(true);
  });
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  assert.equal(
    Math.round((await settings.boundingBox())!.height),
    Math.round(await page.evaluate(() => window.visualViewport!.height)),
  );
  await settings.getByRole('tab', { name: 'Key binds', exact: true }).tap();
  const bindButton = settings.getByRole('button', { name: 'Change key for Command palette', exact: true });
  await bindButton.tap();
  const bindInput = settings.getByRole('textbox', { name: 'Type a key for Command palette', exact: true });
  assert(await bindInput.evaluate((input) => input === document.activeElement));
  await page.keyboard.type('Z');
  await bindButton.filter({ hasText: 'Z' }).waitFor();
  await settings.getByRole('button', { name: 'Close', exact: true }).last().tap();
  await settings.waitFor({ state: 'hidden' });

  // The navigation drawer fills the screen.
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  const drawer = page.locator('dialog.btm-side-nav > div');
  await waitForAsync(page, async () => {
    const box = document.querySelector('dialog.btm-side-nav > div')!.getBoundingClientRect();
    return box.left === 0 && box.width === innerWidth;
  });
  await drawer.getByRole('button', { name: 'Close navigation' }).tap();
  await page.locator('dialog.btm-side-nav').waitFor({ state: 'hidden' });

  // Installable: the manifest loads with the session cookie.
  const manifest = await page.evaluate(async () =>
    (await fetch('/manifest.webmanifest', { credentials: 'include' })).json(),
  );
  assert.equal(manifest.display, 'standalone');

  assert.deepEqual(errors, []);
  console.log(
    'PASS mobile key bar, sticky modifiers, kitty encoding, swipes, prefix, narrow layout, viewport, process viewer, switcher, pane search, settings, nav drawer, pairing, and manifest',
  );
} finally {
  await browser.close();
}
