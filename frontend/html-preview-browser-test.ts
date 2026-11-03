/** Run with `bun browser-test-stack.ts html-preview-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const dir = mkdtempSync(path.join(tmpdir(), 'btmux html preview '));
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(
  path.join(dir, 'a page.html'),
  `<!doctype html>
<title>Page</title>
<link rel="stylesheet" href="style.css">
<h1 id="title">Grüße</h1>
<a id="link" href="b.html">next</a>
<img id="local" src="pixel.png">
<img id="remote" src="https://example.invalid/pixel.png">
<div style="height: 5000px"></div>
<script>document.getElementById('title').textContent = 'scripted'; window.parent.ran = true;</script>
<img src="x" onerror="window.parent.ran = true">`,
);
writeFileSync(path.join(dir, 'b.html'), '<!doctype html><p id="second">Second</p>');
writeFileSync(path.join(dir, 'style.css'), '#title { color: rgb(1, 2, 3); }');
writeFileSync(path.join(dir, 'pixel.png'), pixel);
writeFileSync(path.join(dir, 'z.txt'), 'plain\n');
writeFileSync(path.join(dir, 'zz-child.html'), '<!doctype html><p id="child">Child</p><a id="onward" href="b.html">on</a>');
writeFileSync(
  path.join(dir, 'zz-nested.html'),
  `<!doctype html>
<p id="outer">Outer</p>
<a id="ping" href="#next" ping="/api/server/shutdown">next</a>
<iframe src="zz-child.html"></iframe>`,
);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `html-${Date.now()}` }),
});
assert(response.ok);
const session = await response.json();
const snapshot = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
const pane = snapshot.windows[0].panes[0].id;
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({
      headless: true,
      channel: engine === chromium ? process.env.BTMUX_TEST_BROWSER : undefined,
    });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
        let remoteRefused = false;
        page.on('console', (message) => {
          if (/example\.invalid.*Content Security Policy/.test(message.text())) remoteRefused = true;
        });
      await page.goto(`${url}/s/${encodeURIComponent(session.name)}`);
      await page.getByLabel('Access token').fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await waitForAsync(page, async () => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        return !!useStore.getState().config;
      });
      await page.evaluate(
        async ({ pane, dir }) => {
          const { useStore } = await import('/src/state/store.tsx' as string);
          useStore.getState().setFileBrowserOpen(true, dir, pane, 'files');
        },
        { pane, dir },
      );
      await page.getByText('style.css', { exact: true }).first().waitFor();
      await page
        .getByRole('button', { name: 'Close file browser' })
        .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());

      const frame = page.frameLocator('[data-html-preview]');
      // Renders UTF-8 and relative assets; scripts don't run and remote assets don't load.
      await frame.locator('#title').filter({ hasText: 'Grüße' }).waitFor();
      assert.equal(await frame.locator('#title').evaluate((el) => getComputedStyle(el).color), 'rgb(1, 2, 3)');
      await waitForAsync(page, () => {
        const doc = document.querySelector<HTMLIFrameElement>('[data-html-preview]')?.contentDocument;
        return (doc?.querySelector<HTMLImageElement>('#local')?.naturalWidth ?? 0) > 0;
      });
      for (let i = 0; i < 100 && !remoteRefused; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert(remoteRefused, 'the remote image should be refused');
      assert.equal(await page.evaluate(() => 'ran' in window), false);

      const direct = await page.request.get(`${url}/api/preview${encodeURI(dir)}/a%20page.html`);
      assert.equal(direct.status(), 200);
      assert.equal(direct.headers()['content-type'], 'text/html; charset=utf-8');
      assert.match(direct.headers()['content-security-policy'], /sandbox allow-same-origin;.*script-src 'none'/);
      // A UNC root survives the proxy; on Unix its extra slashes are harmless.
      const rooted = await page.request.get(`${url}/api/preview/%2F%2F${encodeURI(dir.slice(1))}/a%20page.html`);
      assert.equal(rooted.status(), 200);

      // Keys reach the file browser from inside the frame.
      await frame.locator('#title').click();
      const scrollTop = () =>
        page.evaluate(
          () =>
            document.querySelector<HTMLIFrameElement>('[data-html-preview]')!.contentDocument!.scrollingElement!.scrollTop,
        );
      assert.equal(await scrollTop(), 0);
      await page.keyboard.press('Control+d');
      await waitForAsync(page, () => {
        const doc = document.querySelector<HTMLIFrameElement>('[data-html-preview]')?.contentDocument;
        return (doc?.scrollingElement?.scrollTop ?? 0) > 0;
      });

      // Toggles to the source and back.
      await page.keyboard.press('v');
      await page.locator('[data-preview-viewport]').getByText('rel="stylesheet"').first().waitFor();
      assert.equal(await page.locator('[data-html-preview]').count(), 0);
      await page.keyboard.press('v');
      await page.locator('[data-html-preview]').waitFor();

      // Links navigate the frame, which keeps its keys.
      await frame.locator('#link').click();
      await frame.locator('#second').waitFor();
      await page.keyboard.press('v');
      await page.locator('[data-preview-viewport]').getByText('rel="stylesheet"').first().waitFor();
      await page.keyboard.press('v');
      await page.locator('[data-html-preview]').waitFor();

      // Other files keep their previews, and keys survive losing the focused frame.
      await frame.locator('#title').click();
      for (let i = 0; i < 4; i++) await page.keyboard.press('j');
      await page.locator('[data-preview-viewport]').getByText('plain').first().waitFor();
      assert.equal(await page.locator('[data-html-preview]').count(), 0);

      for (let i = 0; i < 2; i++) await page.keyboard.press('j');
      const child = frame.frameLocator('iframe');
      const source = page.locator('[data-preview-viewport]').getByText('ping=').first();
      await child.locator('#child').waitFor();

      // A link's ping can't reach the API.
      const delivered: string[] = [];
      page.on('response', (response) => {
        if (response.request().resourceType() === 'ping') delivered.push(response.url());
      });
      await frame.locator('#ping').click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(delivered, []);
      assert((await fetch(`${url}/api/info`, { headers })).ok, 'a ping shut the server down');

      // Nested frames can't keep keys, whichever frame had focus.
      const clickChild = async () => {
        await child.locator('#child').click();
        await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME');
      };
      await frame.locator('#outer').click();
      await clickChild();
      await page.keyboard.press('v');
      await source.waitFor();
      await page.keyboard.press('v');
      await clickChild();
      await page.keyboard.press('v');
      await source.waitFor();
      await page.keyboard.press('v');

      // Their links still work.
      await child.locator('#onward').click();
      await child.locator('#second').waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  console.log('html preview browser test passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers }).catch(() => {});
}
