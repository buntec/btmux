/** `btmux pick`, `confirm`, and `input` against the isolated browser-test stack. */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { waitForAsync } from './browser-test-utils';

const url = process.env.BTMUX_TEST_URL ?? 'http://localhost:5173';
const token = process.env.BTMUX_AUTH_TOKEN;
assert(token, 'BTMUX_AUTH_TOKEN is required');

const LIST = `printf 'alpha\\tfirst note\\nbeta\\ngamma\\n'`;
const PICKER = '[data-pane-widget]';
const SHOWN = `${PICKER}:not(.opacity-0)`;

const browser = await chromium.launch({ headless: true, channel: process.env.BTMUX_TEST_BROWSER });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return useStore.getState().terminals.size > 0;
  });
  const paneId = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    return [...useStore.getState().terminals.keys()][0] as string;
  });

  const api = (path: string) => `${url}/api${path}`;
  const run = (command: string) =>
    page.request.post(api(`/panes/${paneId}/input`), { data: { text: command, keys: ['Enter'] } });
  const screen = async () => (await page.request.get(api(`/panes/${paneId}/capture`))).text();
  const waitForOutput = async (text: string) => {
    const deadline = Date.now() + 15_000;
    let last = '';
    while (Date.now() < deadline) {
      last = await screen();
      if (last.includes(text)) return;
      await page.waitForTimeout(50);
    }
    assert.fail(`never saw ${text} in:\n${last}`);
  };
  const filter = (target: Page = page) => target.locator(`${PICKER} input`);
  const open = async (args = '') => {
    await run(`clear; ${LIST} | "$BTMUX_BIN" pick ${args}; echo "rc=$?"`);
    await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  };
  const closed = () => page.waitForSelector(PICKER, { state: 'detached' });

  // A filtered choice prints only its value, and focus returns to the pane.
  await open('--prompt Choose');
  assert.equal(await filter().getAttribute('placeholder'), 'Choose');
  assert(await filter().evaluate((input) => input === document.activeElement), 'the filter has focus');
  assert((await page.locator(PICKER).innerText()).includes('first note'));
  assert((await page.locator(PICKER).innerText()).includes('3/3'));
  const before = await filter().boundingBox();
  await page.keyboard.type('gam');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/3'), PICKER);
  assert.deepEqual(await filter().boundingBox(), before, 'filtering does not move the input');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  const printed = await screen();
  assert(/^gamma$/m.test(printed), printed);
  assert(
    await page.evaluate(() => document.activeElement?.closest('[data-pane-terminal]') !== null),
    'the terminal has focus again',
  );

  // Arrows and Tab move; a description isn't printed.
  await open();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  assert(/^alpha$/m.test(await screen()));

  // Wrapping and clicks.
  await open();
  await page.keyboard.press('ArrowUp');
  await page.locator(PICKER).getByText('beta').click();
  await closed();
  await waitForOutput('rc=0');
  assert(/^beta$/m.test(await screen()));

  // Esc cancels.
  await open();
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');

  // A query starts the filter, and typing continues it.
  await open('--query eta');
  assert.equal(await filter().inputValue(), 'eta');
  assert((await page.locator(PICKER).innerText()).includes('1/3'));
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('3/3'), PICKER);
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');

  // A lone match needs no menu, nor does no match, and neither applies otherwise.
  await run(`clear; ${LIST} | "$BTMUX_BIN" pick --query gam --select-1; echo "rc=$?"`);
  await waitForOutput('rc=0');
  assert(/^gamma$/m.test(await screen()));
  assert.equal(await page.locator(PICKER).count(), 0);
  await run(`clear; ${LIST} | "$BTMUX_BIN" pick --query zzz --exit-0; echo "rc=$?"`);
  await waitForOutput('rc=1');
  assert.equal(await page.locator(PICKER).count(), 0);
  await open('--select-1 --exit-0');
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');

  // Multiple choice: Tab marks across filtering, clicks mark, and input order is printed.
  await open('--multi');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1 marked'), PICKER);
  await page.keyboard.type('alp');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/3'), PICKER);
  await page.locator(PICKER).getByText('alpha').click();
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('2 marked'), PICKER);
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  assert(/^alpha\ngamma$/m.test(await screen()), await screen());

  // With nothing marked, Enter chooses the current item; a second Tab unmarks.
  await open('--multi');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((sel) => !document.querySelector(sel)?.textContent?.includes('marked'), PICKER);
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  assert(/^alpha$/m.test(await screen()));

  // Whole items: line breaks and tabs show on one row and print unchanged.
  await run(`clear; printf 'a b\\nc\\td\\0other\\0' | "$BTMUX_BIN" pick --read0 --print0 | od -c | head -2; echo "rc=$?"`);
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  assert((await page.locator(PICKER).innerText()).includes('a b␤c␉d'));
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  assert(/a\s+b\s+\\n\s+c\s+\\t\s+d\s+\\0/.test(await screen()), await screen());

  // Clicking the terminal doesn't take the keys from the menu.
  await open();
  await page.locator('[data-pane-terminal]').first().click({ position: { x: 900, y: 500 } });
  await page.keyboard.type('bet');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/3'), PICKER);
  assert.equal(await filter().inputValue(), 'bet');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');

  // Below the cursor when it fits, above when it doesn't.
  await open();
  const cursorTop = () =>
    page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const term = [...useStore.getState().terminals.values()][0];
      const { top, bottom } = term.cursorRect();
      return { top, bottom };
    });
  let cursor = await cursorTop();
  let card = (await page.locator(PICKER).boundingBox())!;
  assert(Math.abs(card.y - cursor.bottom) < 40, `below the cursor: ${card.y} vs ${cursor.bottom}`);
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');
  await run(`seq 200; ${LIST} | "$BTMUX_BIN" pick; echo "rc=$?"`);
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  for (const deadline = Date.now() + 10_000; ; await page.waitForTimeout(50)) {
    cursor = await cursorTop();
    card = (await page.locator(PICKER).boundingBox())!;
    const gap = cursor.top - (card.y + card.height);
    if (gap >= -1 && gap < 40) break;
    assert(Date.now() < deadline, `above the cursor: ${card.y + card.height} vs ${cursor.top}`);
  }

  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');

  // Output arriving while it's open moves it with the cursor: the menu and the
  // pane's output come over different sockets, so either can arrive first.
  await run(`clear; (sleep 1; seq 200) & ${LIST} | "$BTMUX_BIN" pick; echo "rc=$?"`);
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  const movedAbove = async () => {
    const box = (await page.locator(PICKER).boundingBox())!;
    const gap = (await cursorTop()).top - (box.y + box.height);
    return gap >= -1 && gap < 40;
  };
  assert(!(await movedAbove()), 'it starts below the cursor');
  for (const deadline = Date.now() + 10_000; !(await movedAbove()); await page.waitForTimeout(50)) {
    assert(Date.now() < deadline, 'it should follow the cursor');
  }
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130');

  // Labels stay whole beside long descriptions; long lists are capped and scroll.
  await run(
    `clear; for i in $(seq 1 300); do printf 'item-%s\\tA long description of this item that keeps going on and on and on and on and on and on and on and on\\n' "$i"; done | "$BTMUX_BIN" pick; echo "rc=$?"`,
  );
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  const text = await page.locator(PICKER).innerText();
  assert(text.includes('300/300') && text.includes('100 more'), text);
  const label = page.locator(PICKER).getByText('item-7', { exact: true });
  assert(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the label is not truncated');
  await page.keyboard.press('ArrowUp');
  const last = page.locator(PICKER).getByText('item-200', { exact: true });
  assert(
    await last.evaluate((el) => {
      const row = el.getBoundingClientRect();
      const list = el.closest('[data-pane-widget]')!.getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom;
    }),
    'the selection scrolls into view',
  );
  await page.keyboard.type('299');
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1/300'), PICKER);
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');
  assert(/^item-299$/m.test(await screen()));

  await run(`clear; ${LIST} | "$BTMUX_BIN" pick; echo "rc=$?"`);
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);

  // Every tab showing the pane has the menu; the first answer closes both.
  const second = await context.newPage();
  await second.goto(page.url());
  await second.waitForSelector(`${PICKER}:not(.opacity-0)`);
  await second.locator(PICKER).getByText('beta').click();
  await closed();
  await second.waitForSelector(PICKER, { state: 'detached' });
  await waitForOutput('rc=0');
  await second.close();

  // A pick survives reloads and leaving its window.
  await open();
  await page.reload();
  await page.waitForSelector(`${PICKER}:not(.opacity-0)`);
  const { session, windowCount } = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const session = useStore.getState().allSessions[0];
    return { session: session.id as string, windowCount: session.windows.length as number };
  });
  assert.equal(windowCount, 1);
  assert((await page.request.post(api(`/sessions/${session}/windows`), { data: {} })).ok());
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && !(el as HTMLElement).offsetParent;
  }, PICKER);
  await page.waitForTimeout(3500);
  assert((await page.request.post(api(`/sessions/${session}/windows/switch`), { data: { index: 0 } })).ok());
  await page.waitForFunction((sel) => !!(document.querySelector(sel) as HTMLElement | null)?.offsetParent, PICKER);
  assert(await filter().evaluate((input) => input === document.activeElement), 'the filter has focus again');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0');

  // A dead CLI closes the menu.
  await run('set +H');
  await run(`clear; ${LIST} | "$BTMUX_BIN" pick & p=$!; sleep 1; kill $p; wait $p; echo "rc=$?"`);
  await page.waitForSelector(PICKER);
  await closed();
  await waitForOutput('rc=143');

  // No items.
  await run(`clear; : | "$BTMUX_BIN" pick; echo "rc=$?"`);
  await waitForOutput('rc=1');
  assert.equal(await page.locator(PICKER).count(), 0);

  // A pane no tab shows fails instead of hanging.
  const other = await page.request.post(api('/sessions'), { data: { name: 'other' } });
  assert(other.ok());
  const hiddenPane = await waitForAsync(page, async () => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const session = useStore.getState().allSessions.find((s: { name: string }) => s.name === 'other');
    return session?.windows[0].panes[0].id as string | undefined;
  });
  const started = Date.now();
  const refused = await page.request.post(api(`/panes/${hiddenPane}/widget`), {
    data: { type: 'pick', prompt: null, items: [{ label: 'x', description: null }] },
  });
  assert.equal(refused.status(), 409);
  assert((await refused.text()).includes('no browser tab'));
  assert(Date.now() - started < 10_000);

  const widget = page.locator(PICKER);
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? '');
  const ask = async (command: string) => {
    await run(`clear; "$BTMUX_BIN" ${command}; echo "rc=$?"`);
    await page.waitForSelector(SHOWN);
  };
  const answered = async (rc: number) => {
    await closed();
    await waitForOutput(`rc=${rc}`);
  };

  // Confirm: Enter takes the safe answer unless told otherwise.
  await ask(`confirm 'Delete it?'`);
  assert((await widget.innerText()).includes('Delete it?'));
  assert.equal(await focusedText(), 'No');
  await page.keyboard.press('Enter');
  await answered(1);
  await ask(`confirm --default-yes 'Keep going?'`);
  assert.equal(await focusedText(), 'Yes');
  await page.keyboard.press('Enter');
  await answered(0);

  // Letters, arrows, clicks, and cancel.
  for (const [key, rc] of [['y', 0], ['Y', 0], ['n', 1], ['Escape', 130], ['Control+c', 130]] as const) {
    await ask(`confirm 'Sure?'`);
    await page.keyboard.press(key);
    await answered(rc);
  }
  await ask(`confirm 'Sure?'`);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Yes');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.textContent === 'No');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Yes');
  await page.keyboard.press('Enter');
  await answered(0);
  await ask(`confirm 'Sure?'`);
  await widget.getByRole('button', { name: 'Yes' }).click();
  await answered(0);

  // Neither a held key nor a click on the question answers, and keys still work after it.
  await ask(`confirm --default-yes 'Sure?'`);
  await page.evaluate(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
  });
  await widget.getByText('Sure?').click();
  await page.waitForTimeout(200);
  assert.equal(await widget.count(), 1, 'still open');
  await page.keyboard.press('n');
  await answered(1);
  assert(
    await page.evaluate(() => document.activeElement?.closest('[data-pane-terminal]') !== null),
    'the terminal has focus again',
  );

  // Keys it took never reach the shell.
  await run(`clear; printf 'typed:'; read -r line; echo "[$line]"`);
  await waitForOutput('typed:');
  await page.keyboard.type('ok');
  await page.keyboard.press('Enter');
  await waitForOutput('[ok]');
  assert(!(await screen()).includes('not found'), await screen());

  // A long question scrolls and leaves the buttons on screen.
  await ask(`confirm "$(seq 200)"`);
  const box = (await widget.boundingBox())!;
  assert(box.y >= 0 && box.y + box.height <= 800, `the question fits: ${JSON.stringify(box)}`);
  const yesBox = (await widget.getByRole('button', { name: 'Yes' }).boundingBox())!;
  assert(yesBox.y + yesBox.height <= box.y + box.height, 'the buttons stay inside it');
  const question = widget.getByText('199');
  assert(
    await question.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'),
    'the question scrolls',
  );
  await page.keyboard.press('Escape');
  await answered(130);

  // Input: the label, default, and text as typed.
  await run(`clear; v="$("$BTMUX_BIN" input --prompt Name --default ab)"; echo "rc=$? [$v]"`);
  await page.waitForSelector(SHOWN);
  assert((await widget.innerText()).includes('Name'));
  assert.equal(await widget.locator('input').inputValue(), 'ab');
  assert(await widget.locator('input').evaluate((input) => input === document.activeElement), 'the field has focus');
  await page.keyboard.type(' héllo wörld');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0 [ab héllo wörld]');
  assert(
    await page.evaluate(() => document.activeElement?.closest('[data-pane-terminal]') !== null),
    'the terminal has focus again',
  );

  // Submitting nothing is an answer; Esc is not.
  await run(`clear; v="$("$BTMUX_BIN" input)"; echo "rc=$? [$v]"`);
  await page.waitForSelector(SHOWN);
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0 []');
  await run(`clear; v="$("$BTMUX_BIN" input --default keep)"; echo "rc=$? [$v]"`);
  await page.waitForSelector(SHOWN);
  await page.keyboard.press('Escape');
  await closed();
  await waitForOutput('rc=130 []');

  // Typing survives neither a reload nor the widget: it reopens with its default.
  await run(`clear; v="$("$BTMUX_BIN" input --default start)"; echo "rc=$? [$v]"`);
  await page.waitForSelector(SHOWN);
  await page.reload();
  await page.waitForSelector(SHOWN);
  assert.equal(await widget.locator('input').inputValue(), 'start');
  await page.keyboard.press('Enter');
  await closed();
  await waitForOutput('rc=0 [start]');

  // Every command fails outside a pane.
  for (const command of [`confirm x`, `input`]) {
    await run(`clear; BTMUX_PANE_ID= "$BTMUX_BIN" ${command}; echo "rc=$?"`);
    await waitForOutput('rc=2');
  }

  assert.deepEqual(errors, []);
  console.log('widget browser test passed');
} finally {
  await browser.close();
}
