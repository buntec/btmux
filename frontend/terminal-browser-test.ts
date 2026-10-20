/** Terminal regressions against the isolated browser-test stack. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let fontRequests = 0;
  await page.route('**/fira-code-*.woff2', async (route) => {
    fontRequests++;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });

  const result = await page.evaluate(async () => {
    const { PaneTerminal } = await import('/src/lib/paneTerminal.ts' as string);
    const { buildTerminalOptions } = await import('/src/components/TerminalPane.tsx' as string);
    const { useStore } = await import('/src/state/store.tsx' as string);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:300px;z-index:9999';
    document.body.appendChild(host);
    const options = {
      ...buildTerminalOptions(useStore.getState().config),
      fontFamily: 'Fira Code, monospace',
      fontSize: 14,
    };
    const wasLoaded = document.fonts.check('400 14px "Fira Code"');
    const term = await PaneTerminal.open(host, options, { cols: 120, rows: 10 });
    try {
      const probe = document.createElement('span');
      probe.textContent = 'Wg';
      probe.style.cssText = 'position:absolute;line-height:normal';
      term.element.appendChild(probe);
      const fontHeight = probe.getBoundingClientRect().height;
      probe.remove();
      const cell = term.measureCell();
      const geometry = { wasLoaded, rowHeight: cell.height, fontHeight };

      term.write('\x1bc\x1b[?1000h');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const data: number[][] = [];
      const off = term.onData((bytes: Uint8Array) => data.push(Array.from(bytes)));
      const row = term.element.querySelector('.term-row:not(.term-scrollback-row)').getBoundingClientRect();
      const clientX = row.left + 99.5 * cell.width;
      const clientY = row.top + cell.height / 2;
      term.element.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX, clientY }),
      );
      const click = data.splice(0);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX, clientY }));
      data.length = 0;

      const wheel = (deltaY: number, init: WheelEventInit = {}) =>
        term.element.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            deltaY,
            ...init,
          }),
        );
      term.write('\x1b[?1006h');
      wheel(cell.height / 4);
      wheel(cell.height / 4);
      wheel(cell.height / 4);
      const partial = data.splice(0);
      wheel(cell.height / 4);
      const sgr = data.splice(0);
      wheel(2 * cell.height, { ctrlKey: true });
      const modified = data.splice(0);
      term.write('\x1b[?1016h');
      wheel(cell.height);
      const pixels = data.splice(0);
      term.write('\x1bc\x1b[?1049h');
      wheel(-2 * cell.height);
      const arrows = data.splice(0);
      term.write('\x1b[?2004h');
      term.paste('a\x1b[201~b');
      const paste = data.splice(0);
      off();

      return {
        geometry,
        click,
        partial,
        sgr,
        modified,
        pixels,
        arrows,
        paste,
        pixelX: Math.floor(clientX - row.left) + 1,
        pixelY: Math.floor(clientY - row.top) + 1,
      };
    } finally {
      term.dispose();
      host.remove();
    }
  });
  assert(!result.geometry.wasLoaded, 'font regression must begin with an unloaded font');
  assert(fontRequests > 0, 'font regression must delay a real font download');
  assert(result.geometry.rowHeight >= result.geometry.fontHeight, JSON.stringify(result.geometry));
  assert.deepEqual(result.click, [[27, 91, 77, 32, 132, 33]], 'column 100 must retain its raw X10 byte');
  assert.deepEqual(result.partial, [], 'sub-cell wheel travel must accumulate');
  const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
  assert.deepEqual(result.sgr, [bytes('\x1b[<65;100;1M')]);
  assert.deepEqual(result.modified, [bytes('\x1b[<81;100;1M'), bytes('\x1b[<81;100;1M')]);
  assert.deepEqual(result.pixels, [bytes(`\x1b[<65;${result.pixelX};${result.pixelY}M`)]);
  assert.deepEqual(result.arrows, [bytes('\x1b[A\x1b[A')]);
  assert.deepEqual(result.paste, [bytes('\x1b[200~a[201~b\x1b[201~')], 'paste must not end bracketed paste early');
  console.log('PASS cold fonts, binary mouse input, wheel throttling, mouse encodings and paste');

  // Clear deep scrollback while a URL is underlined: the rows must stay in view.
  const cleared = await page.evaluate(async () => {
    const { PaneTerminal } = await import('/src/lib/paneTerminal.ts' as string);
    const { buildTerminalOptions } = await import('/src/components/TerminalPane.tsx' as string);
    const { useStore } = await import('/src/state/store.tsx' as string);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:300px;z-index:9999';
    document.body.appendChild(host);
    const term = await PaneTerminal.open(host, buildTerminalOptions(useStore.getState().config), {
      cols: 80,
      rows: 10,
    });
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      term.write(Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\r\n') + '\r\nhttps://example.com');
      await frame();
      term.focus();
      await frame();
      const link = Array.from(term.element.querySelectorAll('.term-row:not(.term-scrollback-row)')).find((row) =>
        row.textContent?.includes('https://'),
      )!;
      const rect = link.getBoundingClientRect();
      const cell = term.measureCell()!;
      const mod = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true };
      link.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: rect.left + 5.5 * cell.width,
          clientY: rect.top + cell.height / 2,
          ...mod,
        }),
      );
      const underlinesBefore = term.element.querySelectorAll('.btm-wterm-url > div').length;
      term.write('\x1b[3J\x1b[H\x1b[2J$ ');
      await frame();
      await frame();
      const el = term.element;
      const row = el.querySelector('.term-row:not(.term-scrollback-row)')!.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      return {
        scrollTop: el.scrollTop,
        inView: row.top >= view.top && row.bottom <= view.bottom,
        underlinesBefore,
        underlinesAfter: el.querySelectorAll('.btm-wterm-url > div').length,
      };
    } finally {
      term.dispose();
      host.remove();
    }
  });
  assert.equal(cleared.underlinesBefore, 1, 'clear regression must begin with an underlined URL');
  assert.equal(cleared.underlinesAfter, 0, 'clear must remove stale URL underlines');
  assert(cleared.inView, `rows scrolled away after clear: ${JSON.stringify(cleared)}`);
  console.log('PASS clear with a hovered URL removes stale underlines and keeps the rows in view');

  // Modifier-hover underlines a soft-wrapped plain-text URL; modifier-click opens it.
  const link = await page.evaluate(async () => {
    const { PaneTerminal } = await import('/src/lib/paneTerminal.ts' as string);
    const { buildTerminalOptions } = await import('/src/components/TerminalPane.tsx' as string);
    const { useStore } = await import('/src/state/store.tsx' as string);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:300px;z-index:9999';
    document.body.appendChild(host);
    const term = await PaneTerminal.open(host, buildTerminalOptions(useStore.getState().config), {
      cols: 30,
      rows: 5,
    });
    const opened: string[] = [];
    const open = window.open;
    window.open = (url?: string | URL) => (opened.push(String(url)), null);
    const data: number[][] = [];
    const off = term.onData((bytes: Uint8Array) => data.push(Array.from(bytes)));
    try {
      term.write('\x1bc\x1b[?1000h\x1b[?1006hsee https://example.com/a/very/long/path.');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const cell = term.measureCell()!;
      const rows = term.element.querySelectorAll('.term-row:not(.term-scrollback-row)');
      const second = rows[1].getBoundingClientRect();
      const at = { clientX: second.left + 3.5 * cell.width, clientY: second.top + cell.height / 2 };
      const mod = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true };
      const target = document.elementFromPoint(at.clientX, at.clientY)!;
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...at, ...mod }));
      const underlines = term.element.querySelectorAll('.btm-wterm-url > div').length;
      const ev = (type: string, init: MouseEventInit) =>
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...at, ...init }));
      const focused = () => term.element.contains(document.activeElement);
      term.blur();
      ev('mousedown', { buttons: 1, ...mod });
      ev('mouseup', mod);
      ev('click', { detail: 1, ...mod });
      const focusedByLink = focused();
      const forwarded = data.splice(0).length;
      ev('mousedown', { buttons: 1 });
      ev('mouseup', {});
      ev('click', { detail: 1 });
      const focusedByPlain = focused();
      const plain = data.splice(0);

      ev('mousedown', { buttons: 1, ...mod });
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ...mod }));
      const outsideForwarded = data.splice(0).length;
      ev('mousedown', { buttons: 1 });
      ev('mouseup', {});
      const afterOutsideRelease = data.splice(0);

      ev('mousedown', { buttons: 1, ...mod });
      window.dispatchEvent(new Event('blur'));
      const underlinesAfterBlur = term.element.querySelectorAll('.btm-wterm-url > div').length;
      ev('mousedown', { buttons: 1 });
      ev('mouseup', {});
      const afterBlur = data.splice(0);

      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...at, ...mod }));
      const underlinesBeforeResize = term.element.querySelectorAll('.btm-wterm-url > div').length;
      term.resize(31, 5);
      const underlinesAfterResize = term.element.querySelectorAll('.btm-wterm-url > div').length;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      term.element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...at, ...mod }));
      const underlinesRefreshed = term.element.querySelectorAll('.btm-wterm-url > div').length;
      term.write('\x1b7\x1b[4;1Hx\x1b8');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const underlinesAfterOutput = term.element.querySelectorAll('.btm-wterm-url > div').length;
      return {
        focusedByLink,
        focusedByPlain,
        underlinesAfterOutput,
        underlines,
        opened,
        forwarded,
        plain,
        outsideForwarded,
        afterOutsideRelease,
        underlinesAfterBlur,
        afterBlur,
        underlinesBeforeResize,
        underlinesAfterResize,
        underlinesRefreshed,
      };
    } finally {
      off();
      window.open = open;
      term.dispose();
      host.remove();
    }
  });
  assert.equal(link.underlines, 2, 'wrapped URL must underline both rows');
  assert.deepEqual(link.opened, Array(3).fill('https://example.com/a/very/long/path'));
  assert.equal(link.forwarded, 0, 'modifier-click on a URL must not reach the application');
  assert.equal(link.focusedByLink, false, 'modifier-click on a URL must not focus the pane');
  assert.equal(link.focusedByPlain, true, 'a plain click after a link click must focus the pane');
  const plainClick = [bytes('\x1b[<0;4;2M'), bytes('\x1b[<0;4;2m')];
  assert.deepEqual(link.plain, plainClick, 'plain click must send both press and release');
  assert.equal(link.outsideForwarded, 0, 'a link click released outside the pane must not reach the application');
  assert.deepEqual(link.afterOutsideRelease, plainClick, 'an outside release must not swallow the next release');
  assert.equal(link.underlinesAfterBlur, 0, 'focus loss must clear URL hover');
  assert.deepEqual(link.afterBlur, plainClick, 'focus loss must not swallow the next release');
  assert.equal(link.underlinesBeforeResize, 2, 'resize regression must begin with an underlined URL');
  assert.equal(link.underlinesAfterResize, 0, 'resize must remove stale URL underlines');
  assert.equal(link.underlinesRefreshed, 2, 'hover must rebuild the resized URL underlines');
  assert.equal(link.underlinesAfterOutput, 2, 'output must not drop the hovered URL underline');
  console.log('PASS wrapped URL clicks, focus, outside releases, focus loss, resize, and output hover');

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const store = useStore.getState();
    store.setSearchPaneId([...store.terminals.keys()][0]);
  });
  const search = page.getByLabel('Search scrollback');
  await search.fill('x'.repeat(1025));
  assert.equal((await search.inputValue()).length, 1024);
  await search.press('Escape');
  await search.waitFor({ state: 'detached' });
  assert(await page.locator('[data-pane-id]').count(), 'long search must retain the app');
  assert.deepEqual(errors, []);
  console.log('PASS oversized scrollback search stays bounded and leaves the app usable');

  // Closing a mounted dialog returns focus to the active pane.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('%');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Terminal');
  const activePane = await page.evaluate(() =>
    document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id'),
  );
  assert(activePane);
  for (const key of ['s', 'w', 'a']) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press(key);
    await page.waitForFunction(() => document.activeElement?.closest('dialog[open]'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForFunction(
      (pane) => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') === pane,
      activePane,
    );
  }
  console.log('PASS session switcher, window grid, and agent grid return focus to the active pane');
} finally {
  await browser.close();
}
