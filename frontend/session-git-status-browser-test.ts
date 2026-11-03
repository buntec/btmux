/** Run with `bun browser-test-stack.ts session-git-status-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'btmux-session-git-')));
const repo = path.join(parent, 'proj');
const feat = path.join(parent, 'proj-feat');
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
execFileSync('git', ['init', '--initial-branch=main', repo]);
writeFileSync(path.join(repo, 'README'), 'one\n');
git('add', 'README');
git('commit', '-m', 'Initial');
git('remote', 'add', 'origin', path.join(parent, 'origin.git'));
execFileSync('git', ['init', '--bare', '--initial-branch=main', path.join(parent, 'origin.git')]);
git('push', '-u', 'origin', 'main');
git('commit', '--allow-empty', '-m', 'Ahead');
git('worktree', 'add', '-q', '-b', 'feat', feat);

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const name = `git-status-${Date.now()}`;
const created = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name, cwd: repo, window_name: 'main-win' }),
});
assert(created.ok);
const session = await created.json();
const window = await fetch(`${url}/api/sessions/${session.id}/windows`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: 'feat-win', cwd: feat, select: false }),
});
assert(window.ok);

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
try {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/s/${encodeURIComponent(name)}`);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return !!useStore.getState().config;
  });
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setSwitcherOpen(true);
  });
  const dialog = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await dialog.waitFor();

  // main is ahead; the repo token shows it alone until feat has changes.
  const repoToken = dialog.getByLabel('1 ahead', { exact: true });
  await repoToken.waitFor();
  console.log('PASS the repo token shows a worktree status');

  writeFileSync(path.join(feat, 'new'), 'x\n');
  writeFileSync(path.join(repo, 'README'), 'two\n');
  // The union, within a poll.
  await dialog.getByLabel('1 ahead, 1 changed, 1 untracked', { exact: true }).waitFor({ timeout: 10_000 });
  console.log('PASS the repo token shows the union, without reopening');

  await dialog.getByText(name, { exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await dialog.getByText('feat-win', { exact: true }).waitFor();
  await dialog.getByLabel('1 ahead, 1 changed', { exact: true }).waitFor();
  await dialog.getByLabel('1 untracked', { exact: true }).waitFor();
  // Symbols match their badge, whatever the repo color.
  const symbols = dialog.getByLabel('1 ahead, 1 changed', { exact: true });
  const [symbol, badge] = await symbols.evaluate((el) => [
    getComputedStyle(el.firstElementChild!).color,
    getComputedStyle(el.closest('.astryx-token')!).color,
  ]);
  assert.equal(symbol, badge);
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-session-git-status.png') });
  console.log('PASS branch tokens show their own status');

  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-session-git-failure.png') });
  throw error;
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  rmSync(parent, { recursive: true, force: true });
}
