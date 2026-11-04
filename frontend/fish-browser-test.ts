/** The fish integration in real fish (`just test-fish-browser`; requires fish). */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
// The stack's temporary config, never the caller's XDG_CONFIG_HOME: this writes config.fish.
const configHome = process.env.BTMUX_TEST_CONFIG_HOME;
assert(token, 'BTMUX_AUTH_TOKEN is required');
assert(configHome, 'BTMUX_TEST_CONFIG_HOME is required; run this with `just test-fish-browser`');

const PICKER = '[data-pane-widget]';
const dir = mkdtempSync(join(tmpdir(), 'btmux-fish-'));
writeFileSync(join(dir, 'my file.txt'), '');
writeFileSync(join(dir, 'my other.txt'), '');
const config = (enabled: boolean) =>
  writeFileSync(
    join(configHome, 'fish', 'config.fish'),
    `function fish_prompt; printf '> '; end
set -g fish_autosuggestion_enabled 0
${enabled ? 'set -g btmux_pick_completion 1' : ''}
`,
  );

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  const pane = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return [...useStore.getState().terminals.keys()][0] as string;
  });

  const screen = async () => (await page.request.get(`${url}/api/panes/${pane}/capture`)).text();
  const lastLine = async () => (await screen()).split('\n').filter(Boolean).at(-1) ?? '';
  const until = async (check: (text: string) => boolean, what: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const text = await screen();
      if (check(text)) return;
      assert(Date.now() < deadline, `${what}; the screen shows:\n${text}`);
      await page.waitForTimeout(50);
    }
  };
  const enter = async (line: string) => {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  };
  // Waits until the line reads as expected, then clears it.
  const expectLine = async (line: string) => {
    await until((text) => text.split('\n').filter(Boolean).at(-1) === line, `the line should read ${line}`);
    await page.keyboard.press('Control+u');
    await until((text) => text.split('\n').filter(Boolean).at(-1) === '>', 'the line should clear');
  };
  const startFish = async (enabled: boolean) => {
    config(enabled);
    await enter('exec fish');
    await until((text) => text.split('\n').filter(Boolean).at(-1) === '>', 'fish should start');
  };
  const menu = () => page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  const closed = () => page.waitForSelector(PICKER, { state: 'detached' });

  await until((text) => text.trim().length > 0, 'the shell should start');
  await enter(`cd '${dir}'`);
  await enter('clear; "$BTMUX_BIN" install-fish-integration; echo "installed=$?"');
  await until((text) => text.includes('installed=0'), 'the installer should succeed');
  assert(existsSync(join(configHome, 'fish', 'conf.d', 'btmux.fish')), 'it installs into the test config');
  assert(existsSync(join(configHome, 'fish', 'themes', 'btmux.theme')));

  // Off by default: no binding, and fish's own menu.
  await startFish(false);
  await enter('bind --user tab; echo "user-rc=$status"');
  await until((text) => text.includes('user-rc='), 'bind should report');
  assert(!(await screen()).includes('__btmux_complete'), 'nothing is bound when off');
  await page.keyboard.type('git che');
  await page.keyboard.press('Tab');
  await until((text) => text.includes('Reapply a commit'), "fish's menu should open");
  assert.equal(await page.locator(PICKER).count(), 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+u');

  // On, from config.fish, which runs after conf.d.
  await enter('clear');
  await startFish(true);
  await page.keyboard.type('git che');
  await page.keyboard.press('Tab');
  await menu();
  assert((await page.locator(PICKER).innerText()).includes('Reapply a commit'), 'candidates have descriptions');
  await page.keyboard.type('pick');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/3'), PICKER);
  await page.keyboard.press('Enter');
  await closed();
  await expectLine('> git cherry-pick');

  // Canceling keeps the line.
  await page.keyboard.type('git che');
  await page.keyboard.press('Tab');
  await menu();
  await page.keyboard.press('Escape');
  await closed();
  await expectLine('> git che');

  // One candidate is fish's, with its trailing space.
  await page.keyboard.type('git cherry-p');
  await page.keyboard.press('Tab');
  await until((text) => text.includes('> git cherry-pick'), 'fish should complete it');
  assert.equal(await page.locator(PICKER).count(), 0);
  await page.keyboard.type('x');
  await expectLine('> git cherry-pick x');

  // No candidates: nothing happens.
  await page.keyboard.type('zzz-no-such-command');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  assert.equal(await page.locator(PICKER).count(), 0);
  await expectLine('> zzz-no-such-command');

  // Spaces are escaped, so the name stays one argument.
  await page.keyboard.type('ls my');
  await page.keyboard.press('Tab');
  await menu();
  await page.keyboard.type('other');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/2'), PICKER);
  await page.keyboard.press('Enter');
  await closed();
  await until((text) => text.split('\n').filter(Boolean).at(-1) === '> ls my\\ other.txt', 'the space is escaped');
  await page.keyboard.press('Enter');
  await until((text) => /^'?my other\.txt'?$/m.test(text), 'ls should find one file');

  // Vi mode's insert mode is bound too.
  await enter('clear; fish_vi_key_bindings');
  await page.keyboard.type('git che');
  await page.keyboard.press('Tab');
  await menu();
  await page.keyboard.press('Escape');
  await closed();
  await page.keyboard.press('Control+u');
  await enter('clear; fish_default_key_bindings');

  // With no tab to show the menu, fish's opens, and further Tabs move through it.
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    useStore.setState({ setWidgets: () => {} });
  });
  await page.keyboard.type('git che');
  await page.keyboard.press('Tab');
  await until((text) => text.includes('Reapply a commit'), "fish's menu should open as the fallback");
  await page.keyboard.press('Tab');
  await until((text) => text.split('\n').some((line) => line.trimEnd() === '> git checkout'), 'Tab should select in fish menu');

  assert.deepEqual(errors, []);
  console.log('PASS the fish integration: theme install, opt-in, menu, fallbacks, escaping, and vi mode');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
