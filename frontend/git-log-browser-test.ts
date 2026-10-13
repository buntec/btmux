/** Run with `bun browser-test-stack.ts git-log-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const repo = mkdtempSync(path.join(tmpdir(), 'btmux-log-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '--initial-branch=main');
writeFileSync(path.join(repo, 'README'), 'one\n');
git('add', 'README');
git('commit', '-m', 'Initial');
writeFileSync(path.join(repo, 'README'), 'new\nmore\n');
writeFileSync(path.join(repo, 'added.txt'), 'two\nlines');
writeFileSync(path.join(repo, 'image.bin'), new Uint8Array([0, 1, 2]));
git('add', '.');
git('commit', '-m', 'Changes');
git('commit', '--allow-empty', '-m', 'Empty');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `log-${Date.now()}` }),
});
assert(response.ok);
const session = await response.json();
const snapshot = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
const pane = snapshot.windows[0].panes[0].id;
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
try {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/s/${encodeURIComponent(session.name)}`);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return !!useStore.getState().config;
  });
  await page.evaluate(
    async ({ pane, repo }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      useStore.getState().setFileBrowserOpen(true, repo, pane, 'git');
    },
    { pane, repo },
  );
  await page.getByText('main', { exact: true }).first().waitFor();
  await page
    .getByRole('button', { name: 'Close file browser' })
    .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());
  await page.keyboard.press('o');
  const preview = page.getByRole('group', { name: 'Commit diff', exact: true });
  const summary = preview.getByRole('region', { name: 'Commit change summary', exact: true });
  await summary.getByRole('status').filter({ hasText: '0 files changed' }).waitFor();
  await page.keyboard.press('j');
  await summary.getByRole('list', { name: 'Changed files', exact: true }).waitFor();
  const changedFile = (name: string) => summary.getByRole('listitem').filter({ hasText: name });
  await changedFile('added.txt').getByText('+2', { exact: true }).waitFor();
  assert(await changedFile('added.txt').getByText('−0', { exact: true }).isVisible());
  assert(await changedFile('README').getByText('+2', { exact: true }).isVisible());
  assert(await changedFile('README').getByText('−1', { exact: true }).isVisible());
  assert(await changedFile('image.bin').getByText('Binary', { exact: true }).isVisible());
  assert.equal(await summary.getByRole('listitem').count(), 3);
  assert.equal(await summary.getByRole('status').innerText(), '3 files changed, 4 insertions(+), 1 deletion(−)');
  assert.equal(await summary.locator('button, a').count(), 0, 'summary rows are display-only');
  const firstPatch = preview.locator('section').first();
  assert((await summary.boundingBox())!.y < (await firstPatch.boundingBox())!.y, 'summary precedes the full diff');
  await preview.getByText('new', { exact: true }).waitFor();
  const addedLine = preview.getByText('new', { exact: true });
  assert.equal(
    await addedLine.evaluate((element) => getComputedStyle(element).color),
    await summary
      .getByText('+2', { exact: true })
      .first()
      .evaluate((element) => getComputedStyle(element).color),
  );
  console.log('PASS per-file counts, binary files, EOF markers, totals and full patch');

  await page.keyboard.press('j');
  await summary.getByRole('status').filter({ hasText: '1 file changed, 1 insertion(+), 0 deletions(−)' }).waitFor();
  assert.equal(await summary.getByRole('listitem').count(), 1);
  assert(await summary.getByText('README', { exact: true }).isVisible());
  assert(await summary.getByText('+1', { exact: true }).isVisible());
  assert(await summary.getByText('−0', { exact: true }).isVisible());
  await page.keyboard.press('k');
  await summary.getByRole('status').filter({ hasText: '3 files changed' }).waitFor();
  await page.keyboard.press('/');
  await page.keyboard.type('Empty');
  await summary.getByRole('status').filter({ hasText: '0 files changed, 0 insertions(+), 0 deletions(−)' }).waitFor();
  await preview.getByText('No changes', { exact: true }).waitFor();
  assert.equal(await summary.getByRole('listitem').count(), 0);
  console.log('PASS commit navigation, filtering and empty commit totals');

  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Open dialogs:', await page.locator('dialog[open]').allTextContents());
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-log-failure.png') });
  throw error;
} finally {
  await browser.close();
  rmSync(repo, { recursive: true, force: true });
  const removed = await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  assert(removed.ok);
}
