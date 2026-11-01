/** Run with `bun browser-test-stack.ts git-worktree-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');
// Worktrees default to siblings of the main one.
const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'btmux-worktrees-')));
const repo = path.join(parent, 'proj');
const sibling = (branch: string) => path.join(parent, `proj-${branch}`);
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
execFileSync('git', ['init', '--initial-branch=main', repo]);
writeFileSync(path.join(repo, 'README'), 'one\n');
git('add', 'README');
git('commit', '-m', 'Initial');
git('branch', 'existing');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `worktrees-${Date.now()}` }),
});
assert(response.ok);
const session = await response.json();
const windows = async () =>
  (await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json()).windows as {
    name: string;
    panes: { id: string }[];
  }[];
const pane = (await windows())[0].panes[0].id;
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
  const openGitMode = async (host = pane) => {
    await page.evaluate(
      async ({ pane, repo }) => {
        const { useStore } = await import('/src/state/store.tsx' as string);
        useStore.getState().navigateToPane(pane);
        useStore.getState().setFileBrowserOpen(true, repo, pane, 'git');
      },
      { pane: host, repo },
    );
    await page.getByText('main', { exact: true }).first().waitFor();
    await page
      .getByRole('button', { name: 'Close file browser' })
      .evaluate((button) => (button.closest('[tabindex="-1"]') as HTMLElement).focus());
  };
  await openGitMode();
  await page.keyboard.press('%');
  const dialog = page.getByRole('dialog', { name: 'Worktrees', exact: true });
  const list = dialog.getByRole('list', { name: 'Worktrees', exact: true });
  const selected = () => list.locator('[aria-current="true"]').innerText();
  await list.getByText('main', { exact: true }).waitFor();
  assert.equal(await list.getByRole('listitem').count(), 1);
  assert.match(await selected(), /^\*\s+main/);
  assert.match(await selected(), /Initial/);
  assert.match(await selected(), /current · main/);
  // The main worktree can't be deleted or locked.
  await page.keyboard.press('d');
  await page.keyboard.press('l');
  assert(await dialog.isVisible());
  assert.doesNotMatch(await selected(), /locked/);
  console.log('PASS worktree list and current selection');

  await page.keyboard.press('n');
  const branchInput = page.getByRole('textbox', { name: 'Branch (existing or new)', exact: true });
  await page.getByRole('dialog', { name: 'Create worktree', exact: true }).getByText('existing', { exact: true }).waitFor();
  await branchInput.fill('feat');
  await page.keyboard.press('Enter');
  await list.getByText('feat', { exact: true }).waitFor();
  assert.match(await selected(), /feat/);
  assert(existsSync(sibling('feat')));
  assert.equal((await windows()).length, 1);
  await page.keyboard.press('l');
  await list.getByText(/locked/).waitFor();
  assert.match(git('worktree', 'list', '--porcelain').toString(), /locked/);
  // git refuses to remove a locked worktree.
  await page.keyboard.press('d');
  await page.keyboard.press('D');
  assert.equal(await page.getByRole('dialog', { name: /Delete worktree/ }).count(), 0);
  await page.keyboard.press('l');
  await list.getByText(/locked/).waitFor({ state: 'detached' });
  // The list is replaced by a spinner while the op runs.
  await list.waitFor();
  console.log('PASS create without a window, lock and unlock');

  writeFileSync(path.join(sibling('feat'), 'new.txt'), 'x\n');
  await page.keyboard.press('d');
  const safe = page.getByRole('dialog', { name: 'Delete worktree feat?', exact: true });
  await safe.getByText(/with its ignored files/).waitFor();
  await page.keyboard.press('y');
  await dialog.getByText(/has uncommitted changes/).waitFor();
  assert(existsSync(sibling('feat')));
  await page.keyboard.press('D');
  const force = page.getByRole('dialog', { name: 'Force delete worktree feat?', exact: true });
  await force.waitFor();
  await page.keyboard.press('Escape');
  await list.waitFor();
  assert(existsSync(sibling('feat')));
  await page.keyboard.press('D');
  await force.waitFor();
  await page.keyboard.press('y');
  await list.getByText('feat', { exact: true }).waitFor({ state: 'detached' });
  await list.waitFor();
  assert(!existsSync(sibling('feat')));
  assert.equal(git('branch', '--list', 'feat').toString().trim(), 'feat');
  console.log('PASS safe delete refusal and force delete');

  await page.keyboard.press('c');
  await branchInput.fill('existing');
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Close file browser' }).waitFor({ state: 'detached' });
  await page.waitForURL(/\/w\/existing$/);
  assert.equal((await windows())[1]?.name, 'existing');
  console.log('PASS create and visit');

  await openGitMode();
  assert.doesNotMatch(page.url(), /\/w\/existing$/);
  await page.keyboard.press('%');
  await list.getByText('existing', { exact: true }).click();
  assert.match(await selected(), /1 pane/);
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForURL(/\/w\/existing$/);
  assert.equal((await windows()).length, 2);
  console.log('PASS visit an existing window');

  // Not from a pane in it.
  await openGitMode((await windows())[1].panes[0].id);
  await page.keyboard.press('%');
  await list.getByText('existing', { exact: true }).click();
  await page.keyboard.press('d');
  assert.equal(await page.getByRole('dialog', { name: /Delete worktree/ }).count(), 0);
  await page.keyboard.press('q');
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Close file browser' }).click();
  console.log("PASS the browser's own worktree is kept");

  await openGitMode();
  await page.keyboard.press('%');
  await list.getByText('existing', { exact: true }).click();
  await page.keyboard.press('d');
  const remove = page.getByRole('dialog', { name: 'Delete worktree existing?', exact: true });
  await remove.getByText(/closes its 1 pane/).waitFor();
  await page.keyboard.press('y');
  await list.getByText('existing', { exact: true }).waitFor({ state: 'detached' });
  await list.waitFor();
  assert(!existsSync(sibling('existing')));
  assert.equal((await windows()).length, 1);
  console.log('PASS delete closes its panes');

  await page.keyboard.press('q');
  await dialog.waitFor({ state: 'hidden' });
  git('worktree', 'add', '-q', '-b', 'gone', sibling('gone'));
  rmSync(sibling('gone'), { recursive: true });
  await page.keyboard.press('%');
  await list.getByText('prunable').waitFor();
  await list.getByText('gone', { exact: true }).click();
  await page.keyboard.press('Enter');
  assert(await dialog.isVisible());
  await page.keyboard.press('p');
  await list.getByText('gone', { exact: true }).waitFor({ state: 'detached' });
  await list.waitFor();
  assert.equal(await list.getByRole('listitem').count(), 1);
  await page.keyboard.press('q');
  await dialog.waitFor({ state: 'hidden' });
  console.log('PASS prune');

  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Open dialogs:', await page.locator('dialog[open]').allTextContents());
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-worktree-failure.png') });
  throw error;
} finally {
  await browser.close();
  const removed = await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  rmSync(parent, { recursive: true, force: true });
  assert(removed.ok);
}
