/** Run with `bun browser-test-stack.ts github-status-browser-test.ts`. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
const ghDir = process.env.BTMUX_TEST_GH;
const configHome = process.env.BTMUX_TEST_CONFIG_HOME;
assert(token && ghDir && configHome, 'run through browser-test-stack.ts');
mkdirSync(ghDir, { recursive: true });

const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'btmux-github-'))), 'proj');
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
execFileSync('git', ['init', '--initial-branch=feat', repo]);
git('commit', '--allow-empty', '-m', 'Initial');
git('remote', 'add', 'origin', 'https://github.com/btmux-test/proj.git');
git('config', 'branch.feat.remote', 'origin');
git('config', 'branch.feat.merge', 'refs/heads/feat');
// As a push leaves it.
git('update-ref', 'refs/remotes/origin/feat', 'HEAD');

type Run = { name: string; status: string; conclusion: string | null };
const countsByState = (runs: Run[]) => {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const state = run.status === 'COMPLETED' ? run.conclusion! : run.status;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => ({ state, count }));
};
const reply = (rollup: string, runs: Run[], review: string | null = null) =>
  writeFileSync(
    path.join(ghDir, 'reply.json'),
    JSON.stringify({
      data: {
        repository: {
          url: 'https://github.com/btmux-test/proj',
          b0: {
            nodes: [
              {
                number: 7,
                title: 'Add the thing',
                url: 'https://github.com/btmux-test/proj/pull/7',
                state: 'OPEN',
                isDraft: false,
                reviewDecision: review,
                headRepositoryOwner: { login: 'btmux-test' },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: rollup,
                          contexts: {
                            totalCount: runs.length,
                            checkRunCountsByState: countsByState(runs),
                            statusContextCountsByState: [],
                            nodes: runs.map((run) => ({ __typename: 'CheckRun', ...run })),
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
          c0: null,
        },
      },
    }),
  );
reply('PENDING', [
  { name: 'build', status: 'IN_PROGRESS', conclusion: null },
  { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
]);

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const name = `github-${Date.now()}`;
const created = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name, cwd: repo }),
});
assert(created.ok);

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

  const badge = page.locator('.astryx-token', { hasText: '#7' });
  await badge.waitFor({ timeout: 20_000 });
  assert.equal(await badge.getAttribute('data-color'), 'yellow');
  assert.equal(await badge.getAttribute('aria-description'), 'Open, 1 of 2 checks pending');
  const log = readFileSync(path.join(ghDir, 'log'), 'utf8');
  assert.match(log, /^api graphql --hostname github\.com /m);
  assert.match(log, / -f owner=btmux-test /);
  assert.match(log, / -f h0=feat /);
  console.log('PASS the pane corner shows the branch PR and pending checks');

  // Pending checks poll sooner.
  reply(
    'SUCCESS',
    [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    'APPROVED',
  );
  const passed = page.locator('.astryx-token[data-color="green"]', { hasText: '#7 · approved' });
  await passed.waitFor({ timeout: 25_000 });
  console.log('PASS finished checks and reviews update');

  // A push moves the remote-tracking ref, which refreshes long before the next poll.
  reply(
    'FAILURE',
    [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
    'APPROVED',
  );
  git('commit', '--allow-empty', '-m', 'Second');
  git('update-ref', 'refs/remotes/origin/feat', 'HEAD');
  const failed = page.locator('.astryx-token[data-color="red"]', { hasText: '#7' });
  await failed.waitFor({ timeout: 15_000 });
  await failed.hover();
  await page.getByText('Failed: lint', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(tmpdir(), 'btmux-github-status.png') });
  console.log('PASS a push refreshes it, and the tooltip lists failed checks');

  assert.equal(await failed.getAttribute('href'), 'https://github.com/btmux-test/proj/pull/7');
  assert.equal(await failed.getAttribute('target'), '_blank');
  console.log('PASS it links to the pull request in a new tab');

  // Keyboard focus shows the tooltip, which describes the link.
  await page.mouse.move(0, 0);
  await page.getByText('Failed: lint', { exact: true }).waitFor({ state: 'hidden' });
  // After a key press, as from Tab, so the focus is `:focus-visible`.
  await page.keyboard.press('Shift');
  await failed.focus();
  const tooltip = page.getByText('Failed: lint', { exact: true });
  await tooltip.waitFor();
  const describedBy = await failed.getAttribute('aria-describedby');
  assert(describedBy);
  assert.match(
    await page.evaluate((id) => document.getElementById(id)?.textContent ?? '', describedBy),
    /Failed: lint/,
  );
  assert.equal(await failed.getAttribute('aria-description'), 'Open, 1 of 2 checks failed');
  console.log('PASS focusing it shows and links the tooltip');

  mkdirSync(path.join(configHome, 'btmux'), { recursive: true });
  writeFileSync(path.join(configHome, 'btmux', 'config.toml'), '[github]\nenabled = false\n');
  await badge.waitFor({ state: 'detached', timeout: 15_000 });
  console.log('PASS [github] enabled = false hides it');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
