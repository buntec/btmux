/** Requires Chrome or Chromium on the server. Run with `just test-browser-surface`. */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');

const log: string[] = [];
const PAGE = `<!doctype html><title>Input test</title>
<style>html,body{margin:0;height:100%;background:rgb(200,30,60)}input{position:absolute;left:50px;top:50px;width:300px;height:40px}</style>
<input id="field" />
<p id="words" style="position:absolute;left:50px;top:150px;margin:0;font:20px/1 sans-serif;color:white;white-space:nowrap">alpha beta gamma delta</p>
<input id="slider" type="range" value="0" style="position:absolute;left:50px;top:200px;width:300px;margin:0" />
<button id="opener" style="position:absolute;left:50px;top:250px;width:100px;height:30px">open</button>
<button id="corner" style="position:fixed;right:0;bottom:0;width:20%;height:20%">corner</button>
<script>
const report = (m) => navigator.sendBeacon('/log?m=' + encodeURIComponent(m));
addEventListener('keydown', (e) => report('down:' + e.key));
addEventListener('mousedown', (e) => report('click:' + e.clientX + ',' + e.clientY));
addEventListener('click', (e) => report('hit:' + e.target.id));
addEventListener('resize', () => report('size:' + innerWidth + 'x' + innerHeight));
addEventListener('mouseup', () => report('selected:' + getSelection().toString()));
document.getElementById('slider').addEventListener('input', (e) => report('slider:' + e.target.value));
document.getElementById('opener').addEventListener('click', () => {
  const popup = window.open('');
  popup.document.write('hidden');
  const timer = setInterval(() => {
    if (popup.closed) {
      clearInterval(timer);
      report('popup-closed');
    }
  }, 100);
});
document.getElementById('field').addEventListener('input', (e) => report('value:' + e.target.value));
</script>`;
const site = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/log') {
      log.push(searchParams.get('m') ?? '');
      return new Response(null, { status: 204 });
    }
    return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } });
  },
});
const pageUrl = `http://127.0.0.1:${site.port}/`;

const until = async (what: string, predicate: () => boolean, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(log)}`);
    await Bun.sleep(25);
  }
};
const canvas = '[data-browser-canvas]';
const addressBar = 'input[placeholder="Search or enter address"]';
const results: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${String(error).split('\n')[0].slice(0, 200)}`);
  }
};
const prefix = async (page: Page, key: string) => {
  await page.keyboard.press('Control+a');
  await page.keyboard.press(key);
};
const connect = async (page: Page) => {
  await page.goto(url);
  const form = page.getByLabel('Access token');
  await form.or(page.locator('[data-pane-terminal]')).first().waitFor();
  if (await form.isVisible()) {
    await form.fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  await page.waitForSelector('[data-pane-terminal]');
};
const pageFocused = (page: Page) => waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'), undefined, 5000);
const clickPage = async (page: Page, x: number, y: number) => {
  const box = (await page.locator(canvas).boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
};
/** Clear what the tab has sent so far, returning it. */
const takeSent = (page: Page) =>
  page.evaluate(() => {
    const sent = (window as any).sent as { socket: string; message: any }[];
    (window as any).sent = [];
    return sent;
  });
const keysSent = (sent: { socket: string; message: any }[]) => sent.filter((s) => s.socket === 'browser' && s.message.type === 'key');
/** Dispatch a keydown at the surface's input; whether the surface canceled it. */
const keydown = (page: Page, init: KeyboardEventInit) =>
  page.evaluate(
    (init) =>
      !document
        .querySelector('[data-browser-input]')!
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init })),
    init,
  );

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  // A Linux client: DPR 1, so canvas pixels are the page's CSS pixels.
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
    (window as any).sent = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols);
        const socket = String(address).includes('/ws/browser') ? 'browser' : String(address).includes('/ws/control') ? 'control' : null;
        if (!socket) return;
        const send = this.send.bind(this);
        this.send = (data: any) => {
          (window as any).sent.push({ socket, message: JSON.parse(data) });
          send(data);
        };
      }
    };
  });
  const page = await context.newPage();
  await connect(page);
  await page.waitForTimeout(500);

  await prefix(page, 'b');
  await waitForAsync(page, () => !!document.querySelector('input[placeholder="Search or enter address"]:focus'), undefined, 10_000);
  await page.keyboard.type(pageUrl);
  await page.keyboard.press('Enter');
  await waitForAsync(page, (expected) => (document.querySelector('input[placeholder="Search or enter address"]') as HTMLInputElement).value === expected, pageUrl, 15_000);
  await pageFocused(page);
  await page.waitForTimeout(800);
  await clickPage(page, 200, 70);
  await until('page click', () => log.includes('click:200,70'));

  await check("2. A follower's first click lands where it was aimed, then it takes over sizing", async () => {
    const other = await context.newPage();
    await other.setViewportSize({ width: 800, height: 600 });
    await connect(other);
    await other.waitForTimeout(300);
    await prefix(other, 'b');
    await waitForAsync(other, (selector) => !!(document.querySelector(selector as string) as HTMLCanvasElement | null)?.width, canvas, 10_000);
    await other.waitForTimeout(800);
    const shown = await other.evaluate((selector) => {
      const element = document.querySelector(selector as string) as HTMLCanvasElement;
      const box = element.getBoundingClientRect();
      const scale = Math.min(box.width / element.width, box.height / element.height);
      const width = element.width * scale;
      const height = element.height * scale;
      return { pageWidth: element.width, pageHeight: element.height, left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
    }, canvas);
    log.length = 0;
    // Bottom right of the frame this tab is showing, outside the size it will take.
    await other.mouse.click(shown.left + shown.width * 0.9, shown.top + shown.height * 0.9);
    await until('click', () => log.some((entry) => entry.startsWith('click:')));
    const [x, y] = log.find((entry) => entry.startsWith('click:'))!.slice(6).split(',').map(Number);
    assert(Math.abs(x - shown.pageWidth * 0.9) < 4 && Math.abs(y - shown.pageHeight * 0.9) < 4, `aimed at ${shown.pageWidth * 0.9},${shown.pageHeight * 0.9}; landed at ${x},${y}`);
    // The corner button moves when the page shrinks; the click must still hit it.
    await until('the click to land', () => log.some((entry) => entry.startsWith('hit:')));
    assert(log.includes('hit:corner'), `the click missed the button: ${JSON.stringify(log)}`);
    await until('resize to this tab', () => log.some((entry) => entry.startsWith('size:')));
    await other.close();
  });

  // Back to the first tab's size, and its keyboard.
  await page.bringToFront();
  await clickPage(page, 200, 70);
  await pageFocused(page);

  await check('1. Ctrl+V reaches the native paste path on a non-Mac client', async () => {
    await takeSent(page);
    assert.equal(await keydown(page, { key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true } as KeyboardEventInit), false, 'Ctrl+V was canceled');
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text', 'PASTED');
      document.querySelector('[data-browser-input]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await until('pasted text', () => log.includes('value:PASTED'));
    assert.deepEqual(keysSent(await takeSent(page)), [], 'Ctrl+V was also forwarded');
  });

  await check('3. Dead keys are left to native composition', async () => {
    await takeSent(page);
    assert.equal(await keydown(page, { key: 'Dead', code: 'Quote' }), false, 'the dead key was canceled');
    assert.deepEqual(keysSent(await takeSent(page)), [], 'the dead key was forwarded');
  });

  await check('4. Printable AltGr input is inserted as text', async () => {
    await takeSent(page);
    log.length = 0;
    const altGr = { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit;
    assert.equal(await keydown(page, altGr), false, 'AltGr @ was canceled');
    assert.deepEqual(keysSent(await takeSent(page)), [], 'AltGr @ was sent as a shortcut');
    // What the browser does next for a keydown it wasn't told to cancel.
    await page.evaluate(() => {
      const input = document.querySelector('[data-browser-input]') as HTMLTextAreaElement;
      input.value = '@';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '@', inputType: 'insertText' }));
    });
    await until('@ in the field', () => log.some((entry) => entry.startsWith('value:') && entry.endsWith('@')));
  });

  await check('6a. A doubled prefix reaches the page, not the covered terminal', async () => {
    await pageFocused(page);
    await takeSent(page);
    log.length = 0;
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+a');
    await until('Ctrl+A on the page', () => log.includes('down:a'));
    const sent = await takeSent(page);
    assert.deepEqual(sent.filter((s) => s.message.type === 'write_pane_input'), [], 'the prefix reached the hidden shell');
    assert(keysSent(sent).some((s) => s.message.down && s.message.key === 'a' && s.message.modifiers === 2), 'no Ctrl+A key');
  });

  await check('R1. A drag selects text and moves a slider', async () => {
    await clickPage(page, 700, 300);
    const box = (await page.locator(canvas).boundingBox())!;
    const drag = async (from: [number, number], to: [number, number]) => {
      await page.mouse.move(box.x + from[0], box.y + from[1]);
      await page.mouse.down();
      await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
      await page.waitForTimeout(100);
      await page.mouse.up();
    };
    log.length = 0;
    // Inside the text: past it, on this page, is the document's start, which selects nothing.
    await drag([52, 160], [200, 160]);
    await until('selection', () => log.some((entry) => entry.startsWith('selected:')));
    assert(log.some((entry) => entry.includes('alpha beta')), `nothing selected: ${JSON.stringify(log)}`);
    log.length = 0;
    await drag([52, 208], [300, 208]);
    await until('slider', () => log.some((entry) => entry.startsWith('slider:')), 2000);
  });

  await check('R2. Keys without a keyCode, as from the key bar, still edit', async () => {
    await clickPage(page, 200, 70);
    await page.keyboard.type('qwe');
    log.length = 0;
    await page.evaluate(async () => {
      const { dispatchKey } = await import('/src/lib/paneTerminal.ts' as string);
      const input = document.querySelector('[data-browser-input]')!;
      dispatchKey(input, 'ArrowLeft');
      dispatchKey(input, 'Backspace');
    });
    await until('the edit', () => log.some((entry) => entry.startsWith('value:') && entry.endsWith('qe')), 2000);
  });

  await check('R3. A Ctrl editing chord works from a non-Mac tab', async () => {
    await clickPage(page, 200, 70);
    await page.keyboard.type('ab');
    log.length = 0;
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+a'); // Prefix prefix: a real Ctrl+A.
    await page.waitForTimeout(150);
    await page.keyboard.type('z');
    await until('replaced text', () => log.includes('value:z'), 2000);
  });

  await check('R4. A queued mouse move stays before the press and release', async () => {
    await takeSent(page);
    await page.evaluate((selector) => {
      const element = document.querySelector(selector as string)!;
      const at = { clientX: 800, clientY: 400, bubbles: true, cancelable: true };
      element.dispatchEvent(new MouseEvent('mousemove', at));
      element.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1, detail: 1 }));
      element.dispatchEvent(new MouseEvent('mouseup', { ...at, detail: 1 }));
    }, canvas);
    await page.waitForTimeout(100);
    const kinds = (await takeSent(page)).filter((s) => s.message.type === 'mouse').map((s) => s.message.kind);
    assert.deepEqual(kinds, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  await check('R7. A new tab gets the current cursor', async () => {
    const box = (await page.locator(canvas).boundingBox())!;
    await page.mouse.move(box.x + 90, box.y + 158);
    await waitForAsync(page, (selector) => (document.querySelector(selector as string) as HTMLElement).style.cursor === 'text', canvas, 3000);
    const other = await context.newPage();
    await other.setViewportSize({ width: 800, height: 600 });
    await connect(other);
    await other.waitForTimeout(300);
    await prefix(other, 'b');
    await waitForAsync(other, (selector) => (document.querySelector(selector as string) as HTMLElement | null)?.style.cursor === 'text', canvas, 4000).finally(() => other.close());
  });

  await check('R10. A popup left on about:blank is closed', async () => {
    await page.bringToFront();
    log.length = 0;
    await clickPage(page, 100, 265);
    await until('popup-closed', () => log.includes('popup-closed'), 9000);
  });

  await check('R9. A restored page takes the keyboard, not the address bar', async () => {
    await page.reload();
    await waitForAsync(page, async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      return useStore.getState().terminals.size > 0;
    });
    await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');
    await prefix(page, 'b');
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Browser input');
  });

  await check('R5. A page that keeps crashing stops reloading', async () => {
    // chrome://crash never commits, so each reload returns to the last page: crash it each time.
    const urlValue = () => page.inputValue(addressBar);
    for (let crash = 0; crash < 3; crash++) {
      await pageFocused(page);
      await page.keyboard.press('Control+l');
      await page.keyboard.type('chrome://crash');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }
    await waitForAsync(page, () => (document.querySelector('input[placeholder="Search or enter address"]') as HTMLInputElement).value.startsWith('data:'), undefined, 10_000).catch(async (error) => {
      throw new Error(`address is ${await urlValue()}: ${String(error).slice(0, 60)}`);
    });
    await clickPage(page, 100, 100);
    await page.keyboard.press('Control+l');
    await page.keyboard.type(pageUrl);
    await page.keyboard.press('Enter');
    await waitForAsync(page, (expected) => (document.querySelector('input[placeholder="Search or enter address"]') as HTMLInputElement).value === expected, pageUrl, 10_000);
    await pageFocused(page);
    await page.waitForTimeout(500);
  });

  const activePane = () =>
    page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      const session = state.allSessions[0];
      return { active: state.getActivePaneId(session.id), browser: state.browserPaneId };
    });
  const split = async () => {
    await prefix(page, '%');
    await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');
    const panes = await activePane();
    assert.notEqual(panes.active, panes.browser, 'the split should select the new pane');
  };
  await split();

  await check('6b. A doubled prefix in another pane still reaches that terminal', async () => {
    await takeSent(page);
    log.length = 0;
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+a');
    await waitForAsync(page, () => (window as any).sent.some((s: any) => s.message.type === 'write_pane_input'), undefined, 3000);
    assert.deepEqual(keysSent(await takeSent(page)), [], 'the prefix reached the browser');
  });

  await check('5a. Clicking the address bar activates the browser pane', async () => {
    await page.locator(addressBar).click();
    await waitForAsync(page, async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      return state.getActivePaneId(state.allSessions[0].id) === state.browserPaneId;
    }, undefined, 3000);
    await page.keyboard.press('Escape');
    await pageFocused(page);
  });

  await prefix(page, ';'); // Back to the other pane.
  await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');

  await check('5b. Clicking a toolbar button activates the browser pane', async () => {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitForAsync(page, async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const state = useStore.getState();
      return state.getActivePaneId(state.allSessions[0].id) === state.browserPaneId;
    }, undefined, 3000);
  });

  console.log(results.join('\n'));
  assert(results.every((result) => result.startsWith('PASS')), `${results.filter((r) => r.startsWith('FAIL')).length} checks failed`);
  console.log('browser surface input test passed');
} catch (error) {
  console.log(results.join('\n'));
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: `${process.env.BTMUX_TEST_CONFIG_HOME}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  site.stop(true);
}
