/** Run without a server: bun desktop-launcher-test.ts */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

type Choice = { address: string; profile: string; url: string; bundled: boolean; desktop: boolean };
type Remote = { url: string; profile: string | null; version: string | null; error: string | null };
type Call = { command: string; args?: Record<string, unknown> };
type LauncherWindow = Window & {
  launcherTest: {
    choices: Choice[];
    remotes: Remote[];
    calls: Call[];
    failures: Record<string, string>;
    holdRemotes: boolean;
    releaseRemotes?: () => void;
  };
};

const url = new URL('../desktop/ui/index.html', import.meta.url).href;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const choices = [
  { address: '127.0.0.1:8004', profile: 'default', url: 'http://127.0.0.1:8004/', bundled: false, desktop: false },
  { address: '[::1]:9234', profile: '<work>', url: 'http://[::1]:9234/', bundled: false, desktop: false },
];

async function open(
  servers: Choice[],
  failures: Record<string, string> = {},
  query = '',
  persistent = false,
  remotes: Remote[] = [],
  holdRemotes = false,
) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ servers, failures, persistent, remotes, holdRemotes }) => {
      if (persistent) localStorage.setItem('btmux-persistent', '1');
      const state: LauncherWindow['launcherTest'] = { choices: servers, remotes, failures, calls: [], holdRemotes };
      Object.assign(window, {
        launcherTest: state,
        __TAURI__: {
          core: {
            invoke: async (command: string, args?: Record<string, unknown>) => {
              state.calls.push({ command, args });
              if (command === 'list_remote_servers' && state.holdRemotes) {
                await new Promise<void>((resolve) => {
                  state.releaseRemotes = resolve;
                });
              }
              if (state.failures[command]) throw state.failures[command];
              if (command === 'discover_servers') return state.choices;
              if (command === 'list_remote_servers') return state.remotes;
              if (command === 'add_remote_server') {
                state.remotes.push({ url: String(args?.url), profile: null, version: '0.0.175', error: null });
              }
              if (command === 'remove_remote_server') {
                state.remotes = state.remotes.filter((remote) => remote.url !== args?.url);
              }
            },
          },
        },
      });
    },
    { servers, failures, persistent, remotes, holdRemotes },
  );
  await page.goto(url + query);
  return page;
}

// Remote servers are listed in the background on every refresh.
async function calls(page: Page) {
  return (await allCalls(page)).filter((call) => call.command !== 'list_remote_servers');
}

async function allCalls(page: Page) {
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
  assert.equal(await picker.getByRole('button', { name: /^Stop/ }).count(), 0);
  await picker.close();

  const empty = await open([]);
  await empty.getByRole('status').filter({ hasText: 'Starting the desktop server' }).waitFor();
  assert.deepEqual(await calls(empty), [
    { command: 'discover_servers', args: undefined },
    { command: 'start_server', args: { persistent: false } },
  ]);
  await empty.close();

  // The keep-running choice is remembered and applies to automatic starts.
  const choose = await open(choices);
  await choose.getByRole('button', { name: 'Connect to default' }).waitFor();
  assert(await choose.getByRole('radio', { name: 'Stop it when btmux quits' }).isChecked());
  await choose.getByRole('radio', { name: 'Keep it running after btmux quits' }).check();
  await choose.getByRole('button', { name: 'Start desktop server' }).click();
  assert.deepEqual((await calls(choose)).at(-1), { command: 'start_server', args: { persistent: true } });
  await choose.reload();
  await choose.getByRole('button', { name: 'Connect to default' }).waitFor();
  assert(await choose.getByRole('radio', { name: 'Keep it running after btmux quits' }).isChecked());
  await choose.close();
  const remembered = await open([], {}, '', true);
  await remembered.getByRole('status').filter({ hasText: 'Starting the desktop server' }).waitFor();
  assert.deepEqual((await calls(remembered)).at(-1), { command: 'start_server', args: { persistent: true } });
  await remembered.close();

  const kept = { address: '127.0.0.1:9400', profile: 'desktop', url: 'http://127.0.0.1:9400/', bundled: false, desktop: true };
  const stopping = await open([kept, choices[0]], {}, '?return=switch');
  await stopping.getByText('Keeps running after btmux quits').waitFor();
  assert.equal(await stopping.getByRole('button', { name: /^Stop/ }).count(), 1);
  assert(await stopping.getByRole('button', { name: 'Start desktop server' }).isHidden());
  await stopping.getByRole('button', { name: 'Stop the desktop server' }).click();
  assert.equal((await calls(stopping)).filter((call) => call.command === 'stop_server').length, 0);
  await stopping.evaluate(() => {
    (window as LauncherWindow).launcherTest.choices = (window as LauncherWindow).launcherTest.choices.slice(1);
  });
  await stopping.getByRole('button', { name: 'Confirm stopping the desktop server and closing its shells' }).click();
  await stopping.getByRole('button', { name: 'Connect to default' }).waitFor();
  await stopping.getByRole('button', { name: 'Connect to the desktop server' }).waitFor({ state: 'hidden' });
  assert(await stopping.getByRole('button', { name: 'Start desktop server' }).isVisible());
  assert.deepEqual(
    (await calls(stopping)).slice(1),
    [{ command: 'stop_server', args: { address: '127.0.0.1:9400' } }, { command: 'discover_servers', args: undefined }],
  );
  await stopping.close();

  const unstoppable = await open([kept], { stop_server: 'The server did not stop.' }, '?return=switch');
  await unstoppable.getByRole('button', { name: 'Stop the desktop server' }).click();
  await unstoppable.getByRole('button', { name: /^Confirm stopping/ }).click();
  await unstoppable.getByRole('alert').filter({ hasText: 'The server did not stop.' }).waitFor();
  assert(await unstoppable.getByRole('button', { name: 'Connect to the desktop server' }).isEnabled());
  await unstoppable.close();

  const retry = await open(choices, { connect_server: 'Server exited.' });
  await retry.getByRole('button', { name: 'Connect to default' }).click();
  await retry.getByRole('alert').filter({ hasText: 'Server exited.' }).waitFor();
  await retry.evaluate(() => {
    (window as LauncherWindow).launcherTest.choices = [];
  });
  await retry.getByRole('button', { name: 'Refresh', exact: true }).click();
  await retry.getByText('None running.').waitFor();
  assert.equal((await calls(retry)).filter((call) => call.command === 'start_server').length, 0);
  assert.equal(await retry.locator('#servers li').count(), 0);
  await retry.getByRole('button', { name: 'Start desktop server' }).click();
  assert.equal((await calls(retry)).filter((call) => call.command === 'start_server').length, 1);
  await retry.close();

  const failed = await open([], { start_server: 'Desktop profile is in use.' });
  await failed.getByRole('alert').filter({ hasText: 'Desktop profile is in use.' }).waitFor();
  assert(await failed.getByRole('button', { name: 'Refresh', exact: true }).isEnabled());
  await failed.close();

  const lost = await open([], {}, '?return=lost');
  await lost.getByRole('alert').filter({ hasText: 'stopped responding' }).waitFor();
  assert.deepEqual(
    (await calls(lost)).map((call) => call.command),
    ['discover_servers'],
  );
  await lost.close();

  const bundled = { address: '127.0.0.1:9300', profile: 'desktop', url: 'http://127.0.0.1:9300/', bundled: true, desktop: true };
  const switcher = await open([bundled], {}, '?return=switch');
  await switcher.getByRole('button', { name: 'Connect to the desktop server' }).waitFor();
  assert.equal(await switcher.getByText('Stops when btmux quits').count(), 1);
  assert.equal(await switcher.getByRole('alert').isHidden(), true);
  await switcher.close();
  // Saved remote servers suppress the automatic start and list their state.
  const box: Remote = { url: 'https://box.tail1.ts.net:8004', profile: null, version: '0.0.175', error: null };
  const down: Remote = { url: 'https://down.example', profile: 'work', version: null, error: 'Could not reach https://down.example.' };
  const remotes = await open([], {}, '', false, [box, down]);
  await remotes.getByRole('button', { name: `Connect to ${box.url}` }).waitFor();
  await remotes.getByText('btmux · 0.0.175').waitFor();
  await remotes.getByText(down.error!).waitFor();
  assert.equal((await calls(remotes)).filter((call) => call.command === 'start_server').length, 0);
  assert(await remotes.getByRole('button', { name: 'Start desktop server' }).isEnabled());
  await remotes.getByRole('button', { name: `Connect to ${down.url}` }).click();
  assert.deepEqual((await calls(remotes)).at(-1), { command: 'connect_remote_server', args: { url: down.url } });
  await remotes.close();

  // An unreachable remote doesn't hold up local servers.
  const slow = await open(choices, {}, '', false, [box], true);
  await slow.getByRole('button', { name: 'Connect to default' }).waitFor();
  assert(await slow.getByRole('button', { name: 'Connect to default' }).isEnabled());
  assert.equal(await slow.getByRole('button', { name: `Connect to ${box.url}` }).count(), 0);
  await slow.evaluate(() => (window as LauncherWindow).launcherTest.releaseRemotes?.());
  await slow.getByRole('button', { name: `Connect to ${box.url}` }).waitFor();
  assert(await slow.getByRole('button', { name: `Connect to ${box.url}` }).isEnabled());
  await slow.close();

  // Adding checks the server first; a failure keeps the form filled in.
  const adding = await open(choices, { add_remote_server: 'The server rejected this token.' });
  await adding.getByRole('button', { name: 'Connect to default' }).waitFor();
  assert.equal(await adding.getByRole('textbox').count(), 0);
  await adding.getByRole('button', { name: 'Add server' }).click();
  await adding.getByRole('textbox', { name: 'Address' }).fill('box.tail1.ts.net:8004');
  await adding.getByLabel('Access token').fill('secret-token');
  await adding.getByRole('button', { name: 'Save server' }).click();
  await adding.getByRole('alert').filter({ hasText: 'The server rejected this token.' }).waitFor();
  assert.equal(await adding.getByRole('textbox', { name: 'Address' }).inputValue(), 'box.tail1.ts.net:8004');
  assert.deepEqual((await calls(adding)).at(-1), {
    command: 'add_remote_server',
    args: { url: 'box.tail1.ts.net:8004', token: 'secret-token' },
  });
  await adding.evaluate(() => {
    (window as LauncherWindow).launcherTest.failures = {};
  });
  await adding.getByRole('button', { name: 'Save server' }).click();
  await adding.getByRole('button', { name: 'Connect to box.tail1.ts.net:8004' }).waitFor();
  assert(await adding.getByRole('textbox', { name: 'Address' }).isHidden());
  assert(await adding.getByRole('button', { name: 'Add server' }).isVisible());
  await adding.getByRole('button', { name: 'Remove box.tail1.ts.net:8004' }).click();
  await adding.getByRole('button', { name: 'Connect to box.tail1.ts.net:8004' }).waitFor({ state: 'detached' });
  assert.deepEqual(
    (await allCalls(adding)).slice(-3).map((call) => call.command),
    ['remove_remote_server', 'list_remote_servers', 'discover_servers'],
  );
  await adding.close();

  assert.deepEqual(errors, []);
  console.log('PASS desktop discovery choices, automatic startup, keep-running choice, stopping, connection, refresh, return, error recovery, and remote servers');
} finally {
  await browser.close();
}
