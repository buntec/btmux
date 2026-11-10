/** Run with `bun browser-test-stack.ts sandbox-browser-test.ts`, which puts a fake `multipass` on the server's PATH. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const backendUrl = process.env.BTMUX_TEST_BACKEND_URL;
const token = process.env.BTMUX_AUTH_TOKEN;
const fake = process.env.BTMUX_TEST_MULTIPASS;
assert(token && backendUrl && fake, 'run through browser-test-stack.ts');

const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'btmux-sandbox-')));
const repo = path.join(parent, 'proj');
const feat = path.join(parent, 'proj-feat');
const elsewhere = path.join(parent, 'elsewhere');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=btmux', '-c', 'user.email=btmux@example.invalid', ...args], {
    cwd,
    env: gitEnv,
  });
execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { env: gitEnv });
git(repo, 'commit', '-q', '--allow-empty', '-m', 'Initial');
git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
execFileSync('git', ['init', '-q', '--initial-branch=main', elsewhere], { env: gitEnv });

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (route: string, init: RequestInit = {}) => {
  const response = await fetch(`${backendUrl}${route}`, { ...init, headers: { ...headers, ...init.headers } });
  assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response;
};
const sessions = async () => (await (await api('/api/sessions')).json()) as { id: string; name: string; runtime: any }[];
const snapshot = async (id: string) => (await api(`/api/sessions/${id}`)).json();
/** The fake's calls, each as its arguments. */
const calls = () =>
  existsSync(path.join(fake, 'log'))
    ? readFileSync(path.join(fake, 'log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
    : [];
const shellExecs = () => calls().filter((args) => args[0] === 'exec' && args.includes('env'));
async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

// A local session in the linked worktree, whose pane the dialog defaults to.
const local = await (
  await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'local', cwd: feat }) })
).json();

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
try {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/s/local`);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const state = useStore.getState();
    const session = state.allSessions.find((s: { name: string }) => s.name === 'local');
    return !!state.config?.multipass && !!session?.windows[0]?.panes[0]?.git;
  });

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.getState().setOverlay({ mode: 'prompt', title: 'new-session', value: '', action: 'new-session' });
  });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('sandboxed');
  await dialog.getByLabel('Runs on').click();
  await page.getByRole('option', { name: /Multipass sandbox/ }).click();
  assert.equal(await dialog.getByLabel('Mount').inputValue(), feat);
  await dialog.getByLabel('Shell').click();
  await page.getByRole('option', { name: 'bash', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  const sandboxed = await until('the sandboxed session', async () =>
    (await sessions()).find((s) => s.name === 'sandboxed'),
  );
  assert.deepEqual(sandboxed.runtime, { type: 'multipass', mounts: [feat, path.join(repo, '.git')], shell: 'bash' });
  console.log("PASS the dialog creates a sandboxed session that mounts the worktree and its repository's .git");

  await page.goto(`${url}/s/sandboxed`);
  const [shell] = await until('the guest shell', async () => shellExecs().length > 0 && shellExecs());
  const launches = calls().filter((args) => args[0] === 'launch');
  assert.equal(launches.length, 1);
  assert(launches[0].includes('--cloud-init'));
  for (const mount of [feat, path.join(repo, '.git')]) {
    assert(
      calls().some((args) => args[0] === 'mount' && args[1] === mount && args[2] === `btmux-sandbox:${mount}`),
      `mounts ${mount}`,
    );
  }
  assert.deepEqual(shell.slice(0, 5), ['exec', 'btmux-sandbox', '-d', feat, '--']);
  assert.equal(shell.at(-2), 'bash');
  const env = Object.fromEntries(
    shell.filter((arg) => /^[A-Z_]+=/.test(arg)).map((arg) => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
  );
  const paneId = (await snapshot(sandboxed.id)).windows[0].panes[0].id;
  assert.equal(env.BTMUX_PANE_ID, paneId);
  assert.equal(env.BTMUX_API_URL, backendUrl);
  assert.equal(env.BTMUX_OTEL_ENDPOINT, `${backendUrl}/api/panes/${paneId}/telemetry`);
  assert.equal(env.BTMUX_BIN, '/usr/local/bin/btmux');
  assert(env.BTMUX_AUTH_TOKEN && env.BTMUX_AUTH_TOKEN !== token, 'the guest gets its own token');
  const screen = await (await api(`/api/panes/${paneId}/capture?scrollback=true`)).text();
  assert.match(screen, /creating the Multipass instance btmux-sandbox/);
  assert.match(screen, /btmux-sandbox is ready after \d+s/);
  assert.doesNotMatch(screen, /fake cloud-init|Waiting for initialization/, 'the log window clears');
  assert(
    calls().some((args) => args[0] === 'exec' && args.at(-1)?.includes('tail -F -n +1 /var/log/cloud-init-output.log')),
    'reads the cloud-init log while launch waits',
  );
  console.log('PASS the pane creates the instance, mounts, and enters it with the guest token');

  const pane = async () => (await snapshot(sandboxed.id)).windows[0].panes[0];
  const input = (text: string) =>
    api(`/api/panes/${paneId}/input`, { method: 'POST', body: JSON.stringify({ text, keys: ['Enter'] }) });
  await until('the mounted worktree', async () => (await pane()).git?.branch === 'feat');
  await input(`cd ${elsewhere}`);
  await until('a cwd outside the mounts', async () => {
    const current = await pane();
    return current.cwd === elsewhere && current.git === null;
  });
  await input(`cd ${feat}`);
  await until('the worktree again', async () => (await pane()).git?.branch === 'feat');
  console.log("PASS guest cwds under a mount are local; others aren't, though the host has them");

  const guest = (route: string, method = 'POST', extra: Record<string, string> = {}) =>
    fetch(`${env.BTMUX_API_URL}${route}`, {
      method,
      headers: { Authorization: `Bearer ${env.BTMUX_AUTH_TOKEN}`, 'Content-Type': 'application/json', ...extra },
      body: method === 'GET' ? undefined : JSON.stringify({ hook_event_name: 'Notification', message: 'from the guest' }),
    }).then((response) => response.status);
  const localPane = (await snapshot(local.id)).windows[0].panes[0].id;
  assert.equal(await guest(`/api/panes/${paneId}/notify`, 'POST', { 'X-Btmux-Agent-Pid': '1234' }), 204);
  assert.equal((await pane()).unread?.body, 'from the guest');
  assert.equal(await guest(`/api/panes/${localPane}/notify`), 403);
  assert.equal(await guest(`/api/panes/${paneId}/input`), 403);
  assert.equal(await guest('/api/sessions', 'GET'), 403);
  assert.equal(await guest('/api/multipass/bridge'), 403);
  assert.equal(await guest('/ws/control', 'GET'), 403);
  console.log("PASS the guest token reaches only its panes' reports");

  await api(`/api/panes/${paneId}/split`, { method: 'POST', body: JSON.stringify({ direction: 'right' }) });
  await until('the second guest shell', async () => shellExecs().length === 2);
  assert.equal(calls().filter((args) => args[0] === 'launch').length, 1);
  assert.equal(shellExecs()[1][3], feat, 'the split starts in its source pane directory');
  console.log('PASS a second pane reuses the instance and its mounts');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  rmSync(parent, { recursive: true, force: true });
}
