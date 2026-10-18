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
} finally {
  await browser.close();
}
