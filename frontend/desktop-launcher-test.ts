/** Run without a server: bun desktop-launcher-test.ts */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

type Choice = { address: string; profile: string; url: string };
type Call = { command: string; args?: { address: string } };
type LauncherWindow = Window & {
  launcherTest: {
    choices: Choice[];
    calls: Call[];
    failures: Record<string, string>;
  };
};

const url = new URL('../desktop/ui/index.html', import.meta.url).href;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const choices = [
  { address: '127.0.0.1:8004', profile: 'default', url: 'http://127.0.0.1:8004/' },
  { address: '[::1]:9234', profile: '<work>', url: 'http://[::1]:9234/' },
];

async function open(servers: Choice[], failures: Record<string, string> = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ servers, failures }) => {
      const state = { choices: servers, failures, calls: [] as Call[] };
      Object.assign(window, {
        launcherTest: state,
        __TAURI__: {
          core: {
            invoke: async (command: string, args?: { address: string }) => {
              state.calls.push({ command, args });
              if (state.failures[command]) throw state.failures[command];
              if (command === 'discover_servers') return state.choices;
            },
          },
        },
      });
    },
    { servers, failures },
  );
  await page.goto(url);
  return page;
}

async function calls(page: Page) {
  return page.evaluate(() => (window as LauncherWindow).launcherTest.calls);
}

try {
  const picker = await open(choices);
  await picker.getByRole('button', { name: 'Connect to default' }).waitFor();
  assert.deepEqual(
    (await calls(picker)).map((call) => call.command),
    ['discover_servers'],
  );
  assert.equal(await picker.getByRole('button', { name: 'Connect to <work>' }).count(), 1);
  assert.equal(await picker.getByRole('textbox').count(), 0);
  await picker.getByRole('button', { name: 'Connect to <work>' }).click();
  assert.deepEqual((await calls(picker))[1], {
    command: 'connect_server',
    args: { address: '[::1]:9234' },
  });
  assert(await picker.getByRole('button', { name: 'Start desktop server' }).isDisabled());
  await picker.close();

  const empty = await open([]);
  await empty.getByRole('status').filter({ hasText: 'Starting btmux' }).waitFor();
  assert.deepEqual(
    (await calls(empty)).map((call) => call.command),
    ['discover_servers', 'start_server'],
  );
  await empty.close();

  const retry = await open(choices, { connect_server: 'Server exited.' });
  await retry.getByRole('button', { name: 'Connect to default' }).click();
  await retry.getByRole('alert').filter({ hasText: 'Server exited.' }).waitFor();
  await retry.evaluate(() => {
    (window as LauncherWindow).launcherTest.choices = [];
  });
  await retry.getByRole('button', { name: 'Refresh', exact: true }).click();
  await retry.getByRole('heading', { name: 'No running servers found' }).waitFor();
  assert.equal((await calls(retry)).filter((call) => call.command === 'start_server').length, 0);
  assert.equal(await retry.locator('.server').count(), 0);
  await retry.getByRole('button', { name: 'Start desktop server' }).click();
  assert.equal((await calls(retry)).filter((call) => call.command === 'start_server').length, 1);
  await retry.close();

  const failed = await open([], { start_server: 'Desktop profile is in use.' });
  await failed.getByRole('alert').filter({ hasText: 'Desktop profile is in use.' }).waitFor();
  assert(await failed.getByRole('button', { name: 'Refresh', exact: true }).isEnabled());
  await failed.close();
  assert.deepEqual(errors, []);
  console.log('PASS desktop discovery choices, automatic startup, connection, refresh, and error recovery');
} finally {
  await browser.close();
}
