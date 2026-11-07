/** Run with `bun browser-test-stack.ts git-discard-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'btmux-discard-')));
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).toString();
const write = (name: string, text: string) => writeFileSync(path.join(repo, name), text);
const read = (name: string) => readFileSync(path.join(repo, name), 'utf8');
git('init', '--initial-branch=main');
write('a.txt', 'one\n');
write('b.txt', 'one\n');
git('add', '.');
git('commit', '-m', 'Initial');
write('a.txt', 'changed\n');
write('b.txt', 'staged\n');
git('add', 'b.txt');
write('b.txt', 'unstaged\n');
write('new.txt', 'new\n');

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `discard-${Date.now()}` }),
});
assert(response.ok);
const session = await response.json();
const pane = (await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json()).windows[0].panes[0]
  .id as string;
const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
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
      useStore.getState().navigateToPane(pane);
      useStore.getState().setFileBrowserOpen(true, repo, pane, 'git');
    },
    { pane, repo },
  );
  await page.getByText('new.txt', { exact: true }).first().waitFor();
  await page
    .getByRole('button', { name: 'Close file browser' })
    .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());

  const prompt = page.getByText('Discard all unstaged changes to', { exact: false });
  // Chords stay with the browser.
  for (const chord of ['Meta+d', 'Alt+d', 'Meta+Shift+D', 'Alt+Shift+D']) {
    await page.keyboard.press(chord);
    await page.waitForTimeout(100);
    assert.equal(await page.getByText(/^(Discard|Permanently delete)/).count(), 0, chord);
  }

  await page.keyboard.press('D');
  await prompt.waitFor();
  await page.getByText('2 files', { exact: true }).waitFor();
  await page.keyboard.press('n');
  await prompt.waitFor({ state: 'detached' });
  assert.equal(read('a.txt'), 'changed\n');

  await page.keyboard.press('D');
  await page.keyboard.press('y');
  await prompt.waitFor({ state: 'detached' });
  for (let i = 0; read('a.txt') !== 'one\n' && i < 50; i++) await page.waitForTimeout(100);
  assert.equal(read('a.txt'), 'one\n');
  assert.equal(read('b.txt'), 'staged\n', 'staged changes are kept');
  assert.equal(git('status', '--porcelain'), 'M  b.txt\n?? new.txt\n');
  await page.getByText('new.txt', { exact: true }).first().waitFor();
  // Nothing left to discard.
  await page.keyboard.press('D');
  await page.waitForTimeout(100);
  assert.equal(await prompt.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS discard all keeps staged and untracked changes; chords stay with the browser');
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers }).catch(() => {});
  rmSync(repo, { recursive: true, force: true });
}
