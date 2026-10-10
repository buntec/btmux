// Run with `just test-frontend` (bun test).
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { charIndex, NvimWidgets } from './src/lib/nvimWidgets';

afterEach(() => setSystemTime());

/** A msg_show/cmdline content array: [attr, text, hl_id] chunks. */
const content = (...texts: string[]) => texts.map((t) => [0, t, 0]);
const text = (chunks: { text: string }[]) => chunks.map((c) => c.text).join('');

function msg(w: NvimWidgets, kind: string, texts: string[], opts: { replace?: boolean; append?: boolean; id?: number | string } = {}) {
  w.apply('msg_show', [kind, content(...texts), opts.replace ?? false, false, opts.append ?? false, opts.id ?? Math.random()]);
}

test('charIndex converts UTF-8 byte offsets to string indices', () => {
  expect(charIndex('abc', 2)).toBe(2);
  expect(charIndex('üa', 2)).toBe(1);
  expect(charIndex('漢字x', 6)).toBe(2);
  expect(charIndex('🙂x', 4)).toBe(2); // surrogate pair counts as two UTF-16 units
  expect(charIndex('ab', 99)).toBe(2);
});

test('cmdline tracks the highest level and its cursor in characters', () => {
  const w = new NvimWidgets();
  w.apply('cmdline_show', [content('echo "ü"'), 9, ':', '', 0, 1, 0]);
  let { cmdline } = w.snapshot();
  expect(text(cmdline!.content)).toBe('echo "ü"');
  expect(cmdline!.pos).toBe(8); // "ü" is two bytes
  w.apply('cmdline_show', [content('1+1'), 3, '=', '', 0, 2, 0]);
  expect(w.snapshot().cmdline!.firstc).toBe('=');
  w.apply('cmdline_hide', [2, false]);
  expect(w.snapshot().cmdline!.firstc).toBe(':');
  w.apply('cmdline_hide', [1, false]);
  expect(w.snapshot().cmdline).toBeNull();
  expect(w.cmdlineActive).toBe(false);
});

test('cmdline special char is cleared by the next show', () => {
  const w = new NvimWidgets();
  w.apply('cmdline_show', [content('ab'), 2, ':', '', 0, 1, 0]);
  w.apply('cmdline_special_char', ['^', true, 1]);
  expect(w.snapshot().cmdline!.special).toEqual({ c: '^', shift: true });
  w.apply('cmdline_show', [content('ab\t'), 3, ':', '', 0, 1, 0]);
  expect(w.snapshot().cmdline!.special).toBeNull();
});

test('popupmenu show, select, late docs and hide', () => {
  const w = new NvimWidgets();
  w.apply('popupmenu_show', [[['find', 'Function', '', ''], ['format', 'Function', '', 'fmt docs']], -1, 4, 10, 1]);
  expect(w.snapshot().popupmenu!.items[1].info).toBe('fmt docs');
  w.apply('popupmenu_select', [0]);
  w.setInfo(0, '**find** docs');
  w.setInfo(9, 'out of range');
  const menu = w.snapshot().popupmenu!;
  expect(menu.selected).toBe(0);
  expect(menu.items[0].info).toBe('**find** docs');
  w.apply('popupmenu_hide', []);
  expect(w.snapshot().popupmenu).toBeNull();
});

test('short messages become toasts with levels from kind or highlight', () => {
  const w = new NvimWidgets();
  w.apply('hl_group_set', ['WarningMsg', 42]);
  msg(w, 'echo', ['hello']);
  msg(w, 'emsg', ['E492: Not an editor command']);
  w.apply('msg_show', ['echomsg', [[42, 'careful', 7]], false, true, false, 3, '']);
  expect(w.snapshot().messages.map((m) => [m.level, text(m.content)])).toEqual([
    ['info', 'hello'],
    ['error', 'E492: Not an editor command'],
    ['warning', 'careful'],
  ]);
});

test('toasts are replaced by id or replace_last and extended by append', () => {
  const w = new NvimWidgets();
  msg(w, 'echo', ['one'], { id: 'a' });
  msg(w, 'echo', ['two'], { id: 'b' });
  msg(w, 'echo', ['ONE'], { id: 'a' });
  msg(w, 'search_count', ['[2/5]'], { replace: true });
  msg(w, 'echo', [' more'], { append: true });
  expect(w.snapshot().messages.map((m) => text(m.content))).toEqual(['ONE', '[2/5] more']);
});

test('skipped kinds stay out; "empty" clears toasts', () => {
  const w = new NvimWidgets();
  for (const kind of ['progress', 'search_cmd', 'completion']) msg(w, kind, ['x']);
  expect(w.snapshot().messages).toEqual([]);
  msg(w, 'echo', ['hi']);
  msg(w, 'empty', []);
  expect(w.snapshot().messages).toEqual([]);
});

test('toast stack keeps the newest five', () => {
  const w = new NvimWidgets();
  for (let i = 0; i < 8; i++) msg(w, 'echo', [`m${i}`]);
  expect(w.snapshot().messages.map((m) => text(m.content))).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
});

test('multi-line and list output go to the panel, one panel per command', () => {
  const w = new NvimWidgets();
  msg(w, 'list_cmd', ['  1 %a "x" line 1']);
  msg(w, 'echo', ['a\nb']);
  let { panel } = w.snapshot();
  expect(panel!.title).toBe('Output');
  expect(panel!.lines.map((l) => text(l.content))).toEqual(['  1 %a "x" line 1', 'a\nb']);
  // A new command replaces the panel instead of appending to it.
  w.apply('cmdline_hide', [1, false]);
  msg(w, 'shell_out', ['out']);
  msg(w, 'shell_err', ['err']);
  panel = w.snapshot().panel;
  expect(panel!.lines.map((l) => [l.level, text(l.content)])).toEqual([
    ['info', 'out'],
    ['error', 'err'],
  ]);
  expect(w.hasPanel).toBe(true);
  w.dismissPanel();
  expect(w.snapshot().panel).toBeNull();
});

test(':messages history fills the panel; msg_clear clears everything', () => {
  const w = new NvimWidgets();
  w.apply('msg_history_show', [[['emsg', content('E1: bad'), false], ['', content('written'), false]], false]);
  const { panel } = w.snapshot();
  expect(panel!.title).toBe('Messages');
  expect(panel!.lines.map((l) => l.level)).toEqual(['error', 'info']);
  msg(w, 'echo', ['x']);
  w.apply('msg_clear', []);
  expect(w.snapshot().messages).toEqual([]);
  expect(w.snapshot().panel).toBeNull();
});

test('showmode and showcmd are set and cleared with empty content', () => {
  const w = new NvimWidgets();
  w.apply('msg_showmode', [content('recording @q')]);
  w.apply('msg_showcmd', [content('2d')]);
  expect(text(w.snapshot().showmode)).toBe('recording @q');
  expect(text(w.snapshot().showcmd)).toBe('2d');
  w.apply('msg_showmode', [[]]);
  expect(w.snapshot().showmode).toEqual([]);
});

test('progress cards finish, go stale, and expire', () => {
  setSystemTime(new Date(1_000_000));
  const w = new NvimWidgets();
  const base = { text: '', title: 'Indexing', source: 'rust-analyzer', percent: 10 };
  w.setProgress({ ...base, id: 'a', status: 'running' });
  w.setProgress({ ...base, id: 'b', status: 'running' });
  w.setProgress({ ...base, id: 'a', status: 'success', percent: 100 });
  expect(w.snapshot().progress.map((p) => [p.id, p.status])).toEqual([
    ['a', 'success'],
    ['b', 'running'],
  ]);
  setSystemTime(new Date(1_000_000 + 2_000));
  w.prune(Date.now());
  expect(w.snapshot().progress.map((p) => p.id)).toEqual(['b']);
  setSystemTime(new Date(1_000_000 + 61_000));
  w.prune(Date.now());
  expect(w.snapshot().progress).toEqual([]);
});

test("Neovim's own file progress shows only its result, as a toast", () => {
  const w = new NvimWidgets();
  const write = { id: 'bufwrite', title: '', source: 'nvim', percent: 0 };
  // 0.12 never finishes the progress for reads; only a successful write is shown.
  w.setProgress({ ...write, text: '"a.txt"', status: 'running' });
  expect(w.snapshot().messages).toEqual([]);
  w.setProgress({ ...write, text: '"a.txt" 1L, 2B written', status: 'success' });
  const { messages, progress } = w.snapshot();
  expect(progress).toEqual([]);
  expect(messages.map((m) => text(m.content))).toEqual(['"a.txt" 1L, 2B written']);
});

test('toasts expire by level', () => {
  setSystemTime(new Date(2_000_000));
  const w = new NvimWidgets();
  msg(w, 'echo', ['info']);
  msg(w, 'emsg', ['error']);
  setSystemTime(new Date(2_000_000 + 5_000));
  w.prune(Date.now());
  expect(w.snapshot().messages.map((m) => text(m.content))).toEqual(['error']);
  setSystemTime(new Date(2_000_000 + 9_000));
  w.prune(Date.now());
  expect(w.snapshot().messages).toEqual([]);
});

test('signature help is set and cleared', () => {
  const w = new NvimWidgets();
  const sig = { label: 'f(a, b)', param: [5, 6] as [number, number], param_doc: '', doc: '', index: 1, count: 1, row: 3, col: 4 };
  w.setSignature(sig);
  expect(w.snapshot().signature).toEqual(sig);
  w.setSignature(null);
  expect(w.snapshot().signature).toBeNull();
});

test('changed flags updates until the next snapshot', () => {
  const w = new NvimWidgets();
  expect(w.apply('grid_line', [])).toBe(false);
  expect(w.changed).toBe(false);
  msg(w, 'echo', ['x']);
  expect(w.changed).toBe(true);
  w.snapshot();
  expect(w.changed).toBe(false);
  // Highlight bookkeeping alone doesn't need a re-render.
  w.apply('hl_group_set', ['ErrorMsg', 9]);
  expect(w.changed).toBe(false);
});

test('kind icons are stored for the popupmenu', () => {
  const w = new NvimWidgets();
  expect(w.snapshot().kindIcons).toEqual({});
  w.setKindIcons({ Function: { icon: 'ƒ', color: '#8cf8f7' }, Text: { icon: 'T', color: null } });
  expect(w.changed).toBe(true);
  expect(w.snapshot().kindIcons.Function).toEqual({ icon: 'ƒ', color: '#8cf8f7' });
});
