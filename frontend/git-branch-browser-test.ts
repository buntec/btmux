/** Run with `bun browser-test-stack.ts git-branch-browser-test.ts`. */
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
const repo = mkdtempSync(path.join(tmpdir(), 'btmux-branches-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '--initial-branch=main');
writeFileSync(path.join(repo, 'README'), 'one\n');
git('add', 'README');
git('commit', '-m', 'Initial');
git('branch', 'alpha');
const unmerged = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Unmerged').toString().trim();
git('branch', 'unmerged', unmerged);
git('remote', 'add', 'origin', 'https://example.invalid/btmux.git');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('update-ref', 'refs/remotes/origin/topic', 'HEAD');
git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
git('branch', '--set-upstream-to=origin/main', 'main');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `branches-${Date.now()}` }),
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
  await page.keyboard.press('b');
  const branches = page.getByRole('dialog', { name: 'Branches', exact: true });
  const localList = branches.getByRole('list', { name: 'Local branches', exact: true });
  const remoteList = branches.getByRole('list', { name: 'Remote branches', exact: true });
  await localList.getByText('main', { exact: true }).waitFor();
  assert.equal(await localList.getByRole('listitem').count(), 3);
  assert.match(await localList.innerText(), /\[origin\/main\] Initial/);
  const selectedBranch = () => localList.locator('[aria-current="true"]').innerText();
  assert.match(await selectedBranch(), /^\*\s+main/);
  console.log('PASS local branch details and current selection');
  await page.keyboard.press('j');
  assert.match(await selectedBranch(), /unmerged/);
  await page.keyboard.press('k');
  assert.match(await selectedBranch(), /main/);
  await page.keyboard.press('ArrowUp');
  assert.match(await selectedBranch(), /alpha/);
  await page.keyboard.press('ArrowDown');
  assert.match(await selectedBranch(), /main/);
  // Footer hints press their key when clicked, without taking focus from Enter.
  const hintButtons = branches.locator('.astryx-layout-footer button');
  assert(await hintButtons.count());
  assert.deepEqual(
    [...new Set(await hintButtons.evaluateAll((buttons) => buttons.map((button) => button.tabIndex)))],
    [-1],
  );
  await branches.getByRole('button', { name: 'j: select', exact: true }).click();
  assert.match(await selectedBranch(), /unmerged/);
  await branches.getByRole('button', { name: 'k: select', exact: true }).click();
  assert.match(await selectedBranch(), /main/);
  await page.keyboard.press('d');
  await page.keyboard.press('D');
  assert(await branches.isVisible());
  assert.equal(git('branch', '--show-current').toString().trim(), 'main');

  // Both lists show at once; only the focused one shows its selection.
  await remoteList.getByText('origin/topic', { exact: true }).waitFor();
  assert.equal(await remoteList.getByRole('listitem').count(), 2, 'symbolic origin/HEAD is excluded');
  assert.match(await remoteList.innerText(), /Initial/);
  assert.equal(await remoteList.locator('[aria-current="true"]').count(), 0);
  assert.match(await remoteList.innerText(), /origin\/main[\s\S]*upstream/);
  const selectedRemote = () => remoteList.locator('[aria-current="true"]').innerText();
  await page.keyboard.press('Tab');
  assert.match(await selectedRemote(), /origin\/main/, "remote selection starts at HEAD's upstream");
  assert.equal(await localList.locator('[aria-current="true"]').count(), 0);
  assert.match(await localList.innerText(), /main[\s\S]*current, tracking/);
  await page.keyboard.press('j');
  assert.match(await selectedRemote(), /origin\/topic/);
  await page.keyboard.press('d');
  await page.keyboard.press('D');
  assert(await branches.isVisible());
  await page.keyboard.press('Shift+Tab');
  assert.match(await selectedBranch(), /main/, 'each list keeps its selection');
  await page.keyboard.press('Tab');
  assert.match(await selectedRemote(), /origin\/topic/);
  await branches.getByRole('button', { name: 'tab: local', exact: true }).click();
  assert.match(await selectedBranch(), /main/);

  console.log('PASS side-by-side lists, tab focus and branch navigation');

  // A click without mousedown (assistive tech) activates the row's list too.
  await localList.getByText('main', { exact: true }).click();
  await remoteList
    .getByRole('listitem')
    .filter({ hasText: 'origin/topic' })
    .locator('button')
    .evaluate((button: HTMLElement) => {
      button.focus();
      button.click();
    });
  assert.match(await selectedRemote(), /origin\/topic/);
  assert.equal(await localList.locator('[aria-current="true"]').count(), 0);
  // Refreshed refs keep both selections on their branches.
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'Branch name', exact: true }).fill('aardvark');
  await page.keyboard.press('Enter');
  await localList.getByText('aardvark', { exact: true }).waitFor();
  assert.match(await selectedRemote(), /origin\/topic/);
  await page.keyboard.press('Tab');
  assert.match(await selectedBranch(), /^\*\s+main/, 'a branch created before it keeps the selection');
  await localList.getByText('aardvark', { exact: true }).click();
  await page.keyboard.press('d');
  await localList.getByText('aardvark', { exact: true }).waitFor({ state: 'detached' });
  console.log('PASS non-mouse row activation and selections across refreshes');

  await localList.getByText('alpha', { exact: true }).click();
  await page.keyboard.press('d');
  await localList.getByText('alpha', { exact: true }).waitFor({ state: 'detached' });
  await localList.waitFor();
  assert(await branches.isVisible(), 'deleting keeps the list open');
  await localList.getByText('unmerged', { exact: true }).click();
  await page.keyboard.press('d');
  await branches.getByText(/not fully merged/).waitFor();
  assert.equal(git('branch', '--list', 'unmerged').toString().trim(), 'unmerged');
  await page.keyboard.press('D');
  const forceDelete = page.getByRole('dialog', { name: 'Force delete unmerged?', exact: true });
  await forceDelete.waitFor();
  console.log('PASS force delete confirmation opens after safe delete fails');
  await page.keyboard.press('D');
  assert.equal(git('branch', '--list', 'unmerged').toString().trim(), 'unmerged');
  await page.keyboard.press('Escape');
  await localList.waitFor();
  await page.keyboard.press('D');
  await forceDelete.getByRole('button', { name: 'Cancel', exact: true }).click();
  await localList.waitFor();
  await page.keyboard.press('D');
  await forceDelete.waitFor();
  await page.keyboard.press('y');
  await localList.getByText('unmerged', { exact: true }).waitFor({ state: 'detached' });
  await localList.waitFor();
  assert.equal(git('branch', '--list', 'unmerged').toString().trim(), '');
  console.log('PASS force delete cancellation and confirmation');

  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'Branch name', exact: true }).fill('draft');
  await page.keyboard.press('Escape');
  await localList.waitFor();
  assert.equal(git('branch', '--list', 'draft').toString().trim(), '');
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'Branch name', exact: true }).fill('draft');
  await page.keyboard.press('Enter');
  await localList.getByText('draft', { exact: true }).waitFor();
  await localList.getByText('draft', { exact: true }).click();
  await page.keyboard.press('m');
  const newName = page.getByRole('textbox', { name: 'New name', exact: true });
  assert.equal(await newName.inputValue(), 'draft');
  await newName.fill('renamed');
  await page.keyboard.press('Enter');
  await localList.getByText('renamed', { exact: true }).waitFor();
  assert.match(await selectedBranch(), /renamed/);
  await page.setViewportSize({ width: 390, height: 844 });
  const branchBounds = await branches.boundingBox();
  assert(branchBounds && branchBounds.x >= 0 && branchBounds.width <= 390);
  assert(await branches.locator('.astryx-layout-footer').getByText('force delete', { exact: true }).isVisible());
  // Narrow screens show one list at a time.
  await remoteList.waitFor({ state: 'hidden' });
  assert(await localList.isVisible());
  await page.keyboard.press('Tab');
  await localList.waitFor({ state: 'hidden' });
  assert(await remoteList.isVisible());
  await page.keyboard.press('Tab');
  await remoteList.waitFor({ state: 'hidden' });
  // Focus stays in the dialog when a focused row's list hides.
  const nextFrames = () =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const focusInDialog = () => branches.evaluate((dialog) => dialog.contains(document.activeElement));
  await localList.getByText('renamed', { exact: true }).click();
  await page.keyboard.press('Tab');
  await localList.waitFor({ state: 'hidden' });
  await nextFrames();
  assert(await focusInDialog());
  await page.keyboard.press('k');
  assert.match(await selectedRemote(), /origin\/main/);
  await page.keyboard.press('Tab');
  await remoteList.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await localList.getByText('renamed', { exact: true }).click();
  await page.keyboard.press('Tab');
  await page.setViewportSize({ width: 390, height: 844 });
  await localList.waitFor({ state: 'hidden' });
  await nextFrames();
  assert(await focusInDialog());
  await page.keyboard.press('j');
  assert.match(await selectedRemote(), /origin\/topic/);
  await page.keyboard.press('Tab');
  await page.setViewportSize({ width: 1440, height: 900 });
  await remoteList.getByText('origin/topic', { exact: true }).click();
  await page.keyboard.press('Enter');
  await branches.waitFor({ state: 'hidden' });
  assert.equal(git('branch', '--show-current').toString().trim(), 'topic');
  assert.equal(git('rev-parse', '--abbrev-ref', '@{upstream}').toString().trim(), 'origin/topic');
  await page.keyboard.press('b');
  await localList.getByText('topic', { exact: true }).waitFor();
  assert.match(await selectedBranch(), /topic/);
  await page.keyboard.press('q');
  await branches.waitFor({ state: 'hidden' });
  console.log('PASS branch lists, keyboard navigation, local deletion, force confirmation, rename and remote checkout');

  await page.keyboard.press('F');
  await page.getByRole('dialog', { name: 'Pull', exact: true }).waitFor();
  await page.keyboard.press('e');
  await page
    .getByRole('dialog', { name: 'Pull from', exact: true })
    .getByText('origin/main', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  git('remote', 'remove', 'origin');
  await page.keyboard.press('b');
  await localList.waitFor();
  await branches.getByText('No remote branches', { exact: true }).waitFor();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert(await branches.isVisible());
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('Tab');
  await page.keyboard.press('c');
  await page.getByRole('textbox', { name: 'Branch name', exact: true }).fill('created');
  await page.keyboard.press('Enter');
  await branches.waitFor({ state: 'hidden' });
  assert.equal(git('branch', '--show-current').toString().trim(), 'created');

  for (let i = 0; i < 30; i++) git('branch', `zz-${String(i).padStart(2, '0')}`);
  await page.keyboard.press('b');
  await localList.waitFor();
  for (let i = 0; i < 33; i++) await page.keyboard.press('j');
  assert.match(await selectedBranch(), /zz-29/);
  await page.waitForFunction(() => {
    const row = document.querySelector('dialog[open] [aria-label="Local branches"] [aria-current="true"]');
    const content = row?.closest('.astryx-layout-content');
    if (!row || !content) return false;
    const bounds = row.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
  });
  assert(await branches.locator('.astryx-layout-footer').getByText('force delete', { exact: true }).isVisible());
  await page.keyboard.press('q');
  await branches.waitFor({ state: 'hidden' });
  console.log('PASS pull branch picker, empty remote view, create/checkout and long-list scrolling');

  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Open dialogs:', await page.locator('dialog[open]').allTextContents());
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-branch-failure.png') });
  throw error;
} finally {
  await browser.close();
  rmSync(repo, { recursive: true, force: true });
  const removed = await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  assert(removed.ok);
}
