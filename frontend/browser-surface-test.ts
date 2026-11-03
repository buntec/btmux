/** Requires Chrome or Chromium on the server. Run with `just test-browser-surface`. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');

// A page that refuses framing, reporting what it sees over HTTP.
const log: string[] = [];
const PAGE = `<!doctype html><title>Surface test</title>
<style>html,body{margin:0;height:100%;background:rgb(200,30,60)}input{position:absolute;left:50px;top:50px;width:300px;height:40px}</style>
<input id="field" /><a id="popup" href="/second" target="_blank" style="position:absolute;left:50px;top:150px">popup</a>
<p id="words" style="position:absolute;left:50px;top:220px;margin:0;font:20px sans-serif;color:white">selectable</p>
<input id="secret" type="password" value="hunter2" style="position:absolute;left:50px;top:280px;width:300px;height:40px" />
<script>
const report = (m) => navigator.sendBeacon('/log?m=' + encodeURIComponent(m));
addEventListener('keydown', (e) => report('down:' + e.key));
addEventListener('mousedown', (e) => report('click:' + e.clientX + ',' + e.clientY));
addEventListener('resize', () => report('size:' + innerWidth + 'x' + innerHeight));
addEventListener('wheel', (e) => report('wheel:' + e.deltaY));
document.getElementById('field').addEventListener('input', (e) => report('value:' + e.target.value));
report('size:' + innerWidth + 'x' + innerHeight + ':' + devicePixelRatio);
report('agent:' + navigator.userAgent);
report('focus:' + document.hasFocus());
report('webdriver:' + navigator.webdriver);
report('brands:' + navigator.userAgentData.brands.map((b) => b.brand).join());
report('screen-fits:' + (screen.width >= innerWidth && screen.height >= innerHeight));
addEventListener('click', (e) => {
  if (e.target.id === 'popup') return;
  document.body.style.background = 'rgb(30,60,200)';
  report('clicked');
});
</script>`;
const silence = (() => {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
})();
/** Muted video started every way a page can, reported under `where`. */
const autoplayPage = (where: string, body = '') => `<!doctype html><title>Autoplay ${where}</title>
<style>html,body{margin:0;height:100%;background:rgb(200,30,60)}iframe{position:absolute;left:0;top:200px;width:400px;height:200px;border:0;background:rgb(200,30,60)}</style>
<video id="attr" autoplay muted loop src="${silence}"></video>
<div id="host"></div>${body}
<script>
const report = (m) => navigator.sendBeacon('/log?m=' + encodeURIComponent('${where}:' + m));
const scripted = document.createElement('video');
scripted.muted = scripted.loop = true;
scripted.src = '${silence}';
scripted.play().then(() => report('scripted-played'), (e) => report('scripted-' + e.name));
const shadow = document.getElementById('host').attachShadow({ mode: 'closed' });
shadow.innerHTML = '<video autoplay muted loop src="${silence}"></video>';
setTimeout(() => {
  report('attr-paused-' + document.getElementById('attr').paused);
  report('shadow-paused-' + shadow.firstChild.paused);
}, 1000);
addEventListener('click', () => {
  scripted.play().then(() => report('clicked-played'), (e) => report('clicked-' + e.name));
});
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
    // Another site, so another process.
    const iframe = `<iframe src="http://localhost:${site.port}/autoplay-frame"></iframe>`;
    const body =
      pathname === '/autoplay'
        ? autoplayPage('top', iframe)
        : pathname === '/autoplay-frame'
          ? autoplayPage('frame')
          : pathname === '/second'
            ? '<!doctype html><title>Second page</title>second'
            : PAGE;
    if (pathname === '/autoplay-frame') return new Response(body, { headers: { 'Content-Type': 'text/html' } });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    });
  },
});
const pageUrl = `http://127.0.0.1:${site.port}/`;

const until = async (what: string, predicate: () => boolean, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(log)}`);
    await Bun.sleep(25);
  }
};
const logged = (entry: string) => until(entry, () => log.includes(entry));
const canvas = '[data-browser-canvas]';
const shown = (page: Page) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector) as HTMLElement | null;
    return !!element && getComputedStyle(element).visibility === 'visible';
  }, canvas);
/** The canvas's size and the color of its pixel at (`x`, `y`), in fractions of its size. */
const sample = (page: Page, x = 0.9, y = 0.9) =>
  page.evaluate(
    ([selector, x, y]) => {
      const element = document.querySelector(selector as string) as HTMLCanvasElement;
      const pixel = element
        .getContext('2d')!
        .getImageData(Math.floor(element.width * (x as number)), Math.floor(element.height * (y as number)), 1, 1).data;
      const box = element.getBoundingClientRect();
      return { width: element.width, height: element.height, cssWidth: box.width, cssHeight: box.height, rgb: [...pixel].slice(0, 3) };
    },
    [canvas, x, y],
  );
const painted = (page: Page) =>
  waitForAsync(
    page,
    (selector) => {
      const element = document.querySelector(selector as string) as HTMLCanvasElement | null;
      if (!element?.width) return false;
      const [r, g, b] = element.getContext('2d')!.getImageData(Math.floor(element.width * 0.9), Math.floor(element.height * 0.9), 1, 1).data;
      return r > 170 && g < 70 && b < 90;
    },
    canvas,
  );
const prefix = async (page: Page, key: string) => {
  await page.keyboard.press('Control+a');
  await page.keyboard.press(key);
};
/** Page coordinates to the viewport's, given the canvas shows the page 1:1. */
const clickPage = async (page: Page, x: number, y: number) => {
  const box = (await page.locator(canvas).boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
};
const frameCount = (page: Page) => page.evaluate(() => (window as any).browserFrames as number);
const openSockets = (page: Page) => page.evaluate(() => (window as any).browserSockets.filter((s: WebSocket) => s.readyState === 1).length);

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).browserSockets = [];
    (window as any).browserFrames = 0;
    (window as any).browserSent = [];
    window.WebSocket = class extends Original {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols);
        if (!String(address).includes('/ws/browser')) return;
        (window as any).browserSockets.push(this);
        const send = this.send.bind(this);
        this.send = (data: any) => {
          (window as any).browserSent.push(JSON.parse(data).type);
          send(data);
        };
        this.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') (window as any).browserFrames++;
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
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  await page.waitForSelector('[data-pane-terminal]');
  await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');

  // Open: the address bar takes focus on a blank page.
  await prefix(page, 'b');
  await waitForAsync(page, () => !!document.querySelector(`input[placeholder="Search or enter address"]:focus`));

  // Navigate to a page that refuses framing.
  await page.keyboard.type(pageUrl);
  await page.keyboard.press('Enter');
  await until('page load', () => log.some((entry) => entry.startsWith('size:')));
  await painted(page);
  await waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'));
  assert.equal(await page.inputValue('input[placeholder="Search or enter address"]'), pageUrl);
  await waitForAsync(page, (selector) => document.querySelector(selector as string)?.getAttribute('aria-label') === 'Surface test', canvas);
  const agent = log.find((entry) => entry.startsWith('agent:'))!;
  assert(!agent.includes('Headless'), agent);
  assert(log.includes('focus:true'), JSON.stringify(log));
  assert(log.includes('webdriver:false'), JSON.stringify(log));
  const brands = log.find((entry) => entry.startsWith('brands:'))!;
  assert(brands.includes('Chromium') && !brands.includes('Headless'), brands);
  // Enter in the address bar stays out of the page.
  assert(!(await page.evaluate(() => (window as any).browserSent)).includes('insert_text'));

  // Frames are true device pixels at the pane's size.
  await waitForAsync(page, (selector) => {
    const element = document.querySelector(selector as string) as HTMLCanvasElement;
    const box = element.getBoundingClientRect();
    return Math.abs(element.width - box.width * 2) <= 2 && Math.abs(element.height - box.height * 2) <= 2;
  }, canvas);
  const size = await sample(page);
  assert.equal(size.width, Math.round(size.cssWidth) * 2);

  // A quiet page sends no frames.
  await page.waitForTimeout(500);
  const framesBefore = await frameCount(page);
  await page.waitForTimeout(1500);
  assert.equal(await frameCount(page), framesBefore);

  // Mouse: coordinates map 1:1, and the click focuses the page's field.
  await clickPage(page, 200, 70);
  await logged('click:200,70');

  // The page's response reaches the canvas, including jitter while the button is down.
  await clickPage(page, 600, 400);
  await logged('clicked');
  await waitForAsync(
    page,
    (selector) => {
      const element = document.querySelector(selector as string) as HTMLCanvasElement;
      const [r, , b] = element.getContext('2d')!.getImageData(Math.floor(element.width * 0.9), Math.floor(element.height * 0.9), 1, 1).data;
      return r < 70 && b > 170;
    },
    canvas,
  );
  await clickPage(page, 200, 70);

  // Typing, editing keys, and paste reach the page.
  await page.keyboard.type('hey');
  await logged('value:hey');
  await page.keyboard.press('Backspace');
  await logged('value:he');
  await page.evaluate(() => navigator.clipboard.writeText('llo'));
  await page.keyboard.press('ControlOrMeta+v');
  await logged('value:hello');
  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('x');
    await logged('value:x');
  }

  // Copying: a selection reaches this tab's clipboard, and nothing else changes it.
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const copied = (expected: string) => waitForAsync(page, async (text) => (await navigator.clipboard.readText()) === text, expected, 5000);
  const wordBox = (await page.locator(canvas).boundingBox())!;
  await page.mouse.dblclick(wordBox.x + 90, wordBox.y + 232);
  await page.waitForTimeout(150);
  await page.keyboard.press('ControlOrMeta+c');
  await copied('selectable');
  await clickPage(page, 800, 500);
  await page.waitForTimeout(150);
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(400);
  assert.equal(await clipboard(), 'selectable', 'an empty selection must not change the clipboard');
  if (process.platform === 'darwin') {
    await clickPage(page, 200, 70);
    await page.keyboard.press('Meta+a');
    await page.waitForTimeout(100);
    await page.keyboard.press('Meta+c');
    await copied('x');
    await clickPage(page, 200, 300);
    await page.keyboard.press('Meta+a');
    await page.waitForTimeout(100);
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(400);
    assert.equal(await clipboard(), 'x', 'a password field must not be copied');
  }

  // The cursor follows the page.
  const cursorIs = async (x: number, y: number, expected: string) => {
    const box = (await page.locator(canvas).boundingBox())!;
    await page.mouse.move(box.x + x - 3, box.y + y);
    await page.mouse.move(box.x + x, box.y + y);
    await waitForAsync(
      page,
      ([selector, cursor]) => (document.querySelector(selector as string) as HTMLElement).style.cursor === cursor,
      [canvas, expected],
      5000,
    );
  };
  await cursorIs(60, 158, 'pointer');
  await cursorIs(200, 70, 'text');
  await cursorIs(90, 232, 'text');
  await cursorIs(800, 500, 'default');

  // Wheel.
  const box = (await page.locator(canvas).boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.wheel(0, 120);
  // The outer page's emulated 2x halves Playwright's delta; the rest passes through as is.
  await logged('wheel:60');

  // Prefix keys stay btmux's: the page sees neither key, only the bare Control.
  const beforePrefix = log.length;
  await prefix(page, 'q');
  await page.waitForTimeout(300);
  assert(
    !log.slice(beforePrefix).some((entry) => entry === 'down:q' || entry === 'down:a'),
    JSON.stringify(log.slice(beforePrefix)),
  );
  await page.waitForTimeout(1500); // The pane numbers expire.

  // The surface stays on its pane: a split shrinks the page and activates the new pane.
  log.length = 0;
  await prefix(page, '%');
  await until('smaller page', () => log.some((entry) => entry.startsWith('size:')));
  await waitForAsync(
    page,
    (selector) => {
      const element = document.querySelector(selector as string) as HTMLCanvasElement;
      const box = element.getBoundingClientRect();
      return box.width < 700 && Math.abs(element.width - box.width * 2) <= 2;
    },
    canvas,
  );
  await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');

  // Clicking it selects its pane and takes the keyboard back.
  await clickPage(page, 200, 70);
  await waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'));

  // Esc Esc hides it; only the first reaches the page, and streaming stops.
  log.length = 0;
  assert.equal(await openSockets(page), 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitForAsync(page, (selector) => getComputedStyle(document.querySelector(selector as string)!).visibility === 'hidden', canvas);
  await logged('down:Escape');
  await page.waitForTimeout(200);
  assert.equal(log.filter((entry) => entry === 'down:Escape').length, 1);
  await waitForAsync(page, () => (window as any).browserSockets.every((s: WebSocket) => s.readyState === 3));
  await waitForAsync(page, () => document.activeElement?.getAttribute('aria-label') === 'Terminal');

  // The click above turned the page blue; a reload resets it for the checks below.
  await prefix(page, 'b');
  await waitForAsync(page, () => (window as any).browserSockets.at(-1).readyState === 1);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await painted(page);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('b');
  await waitForAsync(page, (selector) => getComputedStyle(document.querySelector(selector as string)!).visibility === 'hidden', canvas);

  // Opening it again keeps the page.
  await prefix(page, 'b');
  assert.equal(await shown(page), true);
  await painted(page);
  await waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'));
  assert.equal(await page.inputValue('input[placeholder="Search or enter address"]'), pageUrl);
  assert.equal(await openSockets(page), 1);

  // A popup becomes a navigation of the one page; Back returns.
  await clickPage(page, 60, 158);
  await waitForAsync(page, (selector) => document.querySelector(selector as string)?.getAttribute('aria-label') === 'Second page', canvas);
  assert.equal(await page.inputValue('input[placeholder="Search or enter address"]'), `${pageUrl}second`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await waitForAsync(page, (selector) => document.querySelector(selector as string)?.getAttribute('aria-label') === 'Surface test', canvas);
  await painted(page);

  // Cmd/Ctrl+L focuses the address bar, Esc returns to the page.
  await waitForAsync(page, () => {
    (document.querySelector('[data-browser-input]') as HTMLElement).focus();
    return document.activeElement?.hasAttribute('data-browser-input');
  });
  await page.keyboard.press('Control+l');
  await waitForAsync(page, () => !!document.querySelector(`input[placeholder="Search or enter address"]:focus`));
  await page.keyboard.press('Escape');
  await waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'));

  // A configured search URL applies live, to text that isn't a URL.
  const configFile = join(process.env.BTMUX_TEST_CONFIG_HOME!, 'btmux', 'config.toml');
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `[browser]\nsearch-url = "${pageUrl}found?q=%s"\n`);
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return !!useStore.getState().config?.browser_search_url;
  });
  await page.keyboard.press('Control+l');
  await page.keyboard.type('two words');
  await page.keyboard.press('Enter');
  await waitForAsync(
    page,
    (expected) => (document.querySelector('input[placeholder="Search or enter address"]') as HTMLInputElement).value === expected,
    `${pageUrl}found?q=two%20words`,
  );
  await painted(page);
  await waitForAsync(page, () => document.activeElement?.hasAttribute('data-browser-input'));

  // A second tab shares the page: it gets the last frame of an idle page, and input makes it the size owner.
  const other = await context.newPage();
  await other.setViewportSize({ width: 800, height: 600 });
  await other.goto(url);
  await waitForAsync(other, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  await other.waitForSelector('[data-pane-terminal]');
  await prefix(other, 'b');
  await painted(other);
  log.length = 0;
  await clickPage(other, 20, 20);
  await until('resize to the other tab', () => log.some((entry) => entry.startsWith('size:')));
  await other.close();

  // Chromium dying reconnects by itself and reopens the page.
  const searched = `${pageUrl}found?q=two%20words`;
  const reopened = async (expected = searched) => {
    await waitForAsync(page, () => !!document.body.textContent?.includes('Reconnecting'), undefined, 10_000);
    await waitForAsync(page, () => !document.body.textContent?.includes('Reconnecting'), undefined, 30_000);
    await waitForAsync(
      page,
      (expected) => (document.querySelector('input[placeholder="Search or enter address"]') as HTMLInputElement).value === expected,
      expected,
      10_000,
    );
    await painted(page);
    assert(!(await page.evaluate(() => document.body.textContent?.includes("The browser isn't running"))));
  };
  const processes = Bun.spawnSync(['ps', '-axo', 'pid=,command=']).stdout.toString().split('\n');
  const root = process.env.BTMUX_TEST_CONFIG_HOME!;
  const main = processes.find(
    (line) => line.includes('--remote-debugging-pipe') && line.includes(root.slice(0, root.lastIndexOf('/'))) && !line.includes('--type='),
  );
  assert(main, 'no Chromium process for this stack');
  process.kill(Number(main.trim().split(/\s+/)[0]), 'SIGKILL');
  await reopened();

  // So does an in-place upgrade.
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const info = await (await fetch(`${url}/api/info`, { headers: auth })).json();
  const upgrade = await fetch(`${url}/api/server/upgrade`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ executable: info.executable }),
  });
  assert.equal(upgrade.status, 202);
  await reopened();
  assert.equal((await (await fetch(`${url}/api/info`, { headers: auth })).json()).pid, info.pid);

  // Nothing plays until the user acts, in any frame or shadow root.
  const autoplayUrl = `${pageUrl}autoplay`;
  log.length = 0;
  await page.click('input[placeholder="Search or enter address"]');
  await page.keyboard.type(autoplayUrl);
  await page.keyboard.press('Enter');
  for (const where of ['top', 'frame']) {
    await logged(`${where}:scripted-NotAllowedError`);
    await logged(`${where}:attr-paused-true`);
    await logged(`${where}:shadow-paused-true`);
  }
  // Clicking plays, in the frame clicked.
  await clickPage(page, 450, 100);
  await logged('top:clicked-played');
  await clickPage(page, 200, 300);
  await logged('frame:clicked-played');

  // Opting out restarts Chromium, which reopens the page.
  log.length = 0;
  writeFileSync(configFile, '[browser]\nblock-autoplay = false\n');
  await reopened(autoplayUrl);
  for (const where of ['top', 'frame']) {
    await logged(`${where}:scripted-played`);
    await logged(`${where}:attr-paused-false`);
    await logged(`${where}:shadow-paused-false`);
  }

  assert.deepEqual(errors, []);
  console.log('browser surface test passed');
} finally {
  await browser.close();
  site.stop(true);
}
