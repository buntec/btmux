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
const other = path.join(parent, 'proj-other');
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
const setSwitcherOpen = (target: typeof page, open: boolean) =>
  target.evaluate(async (open) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setSwitcherOpen(open);
  }, open);
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
  await setSwitcherOpen(page, true);
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
  await page.close();

  // Routing replaces every WebSocket on the page with a mock that throws on
  // frames after close(), so this page doesn't assert on page errors.
  const held: (() => void)[] = [];
  let holding = true;
  let outage = false;
  let connections = 0;
  let sent = 0;
  let answered = 0;
  let closeSocket = () => {};
  const scans: string[] = [];
  const routed = await context.newPage();
  await routed.clock.install();
  await routed.routeWebSocket(/\/ws\/files$/, (socket) => {
    if (outage) {
      socket.close();
      return;
    }
    const connection = ++connections;
    closeSocket = () => void socket.close();
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const { type, payload } = JSON.parse(String(message));
      if (type === 'git_status') {
        scans.push(payload.root);
        sent += 1;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      answered += 1;
      if (holding) held.push(() => connection === connections && socket.send(message));
      else socket.send(message);
    });
  });
  const release = () => {
    holding = false;
    for (const reply of held.splice(0)) reply();
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert(Date.now() < deadline, `timed out: ${condition}`);
      await routed.waitForTimeout(50);
    }
  };
  await routed.goto(`${url}/s/${encodeURIComponent(name)}`);
  await waitForAsync(routed, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().allSessions.length > 0;
  });

  // Pending scans are joined across reopenings, so none repeats.
  await setSwitcherOpen(routed, true);
  await until(() => scans.length === 2);
  for (const open of [false, true, false, true]) {
    await setSwitcherOpen(routed, open);
    await routed.waitForTimeout(100);
  }
  assert.deepEqual([...scans].sort(), [repo, feat].sort());
  console.log('PASS reopening the picker joins pending scans');

  // With the others pending, a changed root list adds only the new root.
  git('worktree', 'add', '-q', '-b', 'other', other);
  const otherWindow = await fetch(`${url}/api/sessions/${session.id}/windows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'other-win', cwd: other, select: false }),
  });
  assert(otherWindow.ok);
  await until(() => scans.includes(other));
  await routed.waitForTimeout(100);
  assert.deepEqual([...scans].sort(), [repo, feat, other].sort());
  console.log('PASS a new root joins pending scans');

  // Replies from before the reopening still arrive.
  release();
  await routed
    .getByRole('dialog', { name: 'Sessions', exact: true })
    .getByLabel('1 ahead, 1 changed, 1 untracked', { exact: true })
    .waitFor();
  console.log('PASS pending scans report after reopening');

  const routedDialog = routed.getByRole('dialog', { name: 'Sessions', exact: true });
  const fresh = routedDialog.getByLabel('1 ahead, 1 changed, 1 untracked', { exact: true });
  const stale = routedDialog.getByLabel('1 ahead, 1 changed, 1 untracked, out of date', { exact: true });
  const elapse = async (time: string) => {
    await routed.clock.fastForward(time);
    await routed.waitForTimeout(150);
  };
  const setHidden = (hidden: boolean) =>
    routed.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  // A hidden tab doesn't poll, and scans again once visible.
  await setHidden(true);
  await routed.waitForTimeout(150);
  scans.length = 0;
  await elapse('00:30');
  assert.deepEqual(scans, []);
  await setHidden(false);
  await until(() => scans.length === 3);
  console.log('PASS a hidden tab stops polling');

  // Unanswered scans show as out of date and aren't repeated.
  await fresh.waitFor();
  await elapse('00:06');
  await until(() => answered === sent);
  holding = true;
  scans.length = 0;
  await elapse('00:06');
  await until(() => scans.length === 3);
  await fresh.waitFor();
  await elapse('00:31');
  await stale.waitFor();
  await elapse('00:06');
  assert.equal(scans.length, 3);
  console.log('PASS overdue scans mark tokens and are not repeated');

  // A silent socket is replaced, and the scans recover on the new one.
  const before = connections;
  scans.length = 0;
  await elapse('00:30');
  await until(() => connections === before + 1);
  await elapse('00:06');
  await until(() => scans.length === 3);
  release();
  await fresh.waitFor();
  console.log('PASS a silent socket reconnects');

  // Scans that failed during an outage aren't sent after it.
  outage = true;
  closeSocket();
  for (let i = 0; i < 4; i++) await elapse('00:06');
  await stale.waitFor();
  scans.length = 0;
  outage = false;
  await elapse('00:03');
  await elapse('00:06');
  await until(() => scans.length >= 3);
  assert.deepEqual([...scans].sort(), [repo, feat, other].sort());
  await fresh.waitFor();
  console.log('PASS an outage queues nothing');
} catch (error) {
  await context.pages()[0]?.screenshot({ path: path.join(tmpdir(), 'btmux-session-git-failure.png') });
  throw error;
} finally {
  await browser.close();
  await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
  rmSync(parent, { recursive: true, force: true });
}
