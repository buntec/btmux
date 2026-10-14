// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { matchesPrefix, parsePrefix as parse, prefixBytes, prefixNvimKeys } from './src/lib/prefixKey';

const parsePrefix = (prefix: string) => {
  const parsed = parse(prefix);
  if (!parsed) throw new Error(`invalid prefix ${prefix}`);
  return parsed;
};

const event = (key: string, init: { ctrl?: boolean; alt?: boolean; code?: string } = {}) =>
  ({ key, code: init.code ?? '', ctrlKey: !!init.ctrl, altKey: !!init.alt }) as KeyboardEvent;

test('prefixes are validated like config.rs', () => {
  expect(parsePrefix('C-space')).toEqual({ ctrl: true, alt: false, key: ' ' });
  expect(parsePrefix('m-c-a')).toEqual({ ctrl: true, alt: true, key: 'a' });
  expect(parsePrefix('C--')).toEqual({ ctrl: true, alt: false, key: '-' });
  expect(parsePrefix('f12').key).toBe('F12');
  expect(parsePrefix('C-arrowup').key).toBe('ArrowUp');
  for (const invalid of ['', 'C-', 'C-spacex', 'C-C-a', 'S-a', 'C-ab', ' ', 'F0', 'F13', 'F01']) {
    expect(parse(invalid)).toBeNull();
  }
});

test('named and composed keys match', () => {
  expect(matchesPrefix(event(' ', { ctrl: true, code: 'Space' }), parsePrefix('C-Space'))).toBe(true);
  expect(matchesPrefix(event(' '), parsePrefix('C-Space'))).toBe(false);
  expect(matchesPrefix(event('A', { ctrl: true }), parsePrefix('C-a'))).toBe(true);
  expect(matchesPrefix(event('A'), parsePrefix('a'))).toBe(false);
  expect(matchesPrefix(event('≈', { alt: true, code: 'KeyX' }), parsePrefix('M-x'))).toBe(true);
  expect(matchesPrefix(event(' ', { alt: true, code: 'Space' }), parsePrefix('M-Space'))).toBe(true);
});

test('Ctrl+letter prefix sends the control character', () => {
  expect(prefixBytes(parsePrefix('C-b'))).toBe('\x02');
  expect(prefixBytes(parsePrefix('C-a'))).toBe('\x01');
  expect(prefixBytes(parsePrefix('C-Space'))).toBe('\x00');
});

test('Alt prefix sends ESC plus the key', () => {
  expect(prefixBytes(parsePrefix('M-b'))).toBe('\x1bb');
  expect(prefixBytes(parsePrefix('C-M-b'))).toBe('\x1b\x02');
  expect(prefixBytes(parsePrefix('M-Enter'))).toBe('\x1b\r');
});

test('unrepresentable prefixes send nothing', () => {
  expect(prefixBytes(parsePrefix('C-Enter'))).toBeNull();
  expect(prefixBytes(parsePrefix('F5'))).toBeNull();
});

test('Neovim gets the prefix in key notation', () => {
  expect(prefixNvimKeys(parsePrefix('C-b'))).toBe('<C-b>');
  expect(prefixNvimKeys(parsePrefix('M-a'))).toBe('<M-a>');
  expect(prefixNvimKeys(parsePrefix('C-M-b'))).toBe('<C-M-b>');
  expect(prefixNvimKeys(parsePrefix('C-<'))).toBe('<C-lt>');
  expect(prefixNvimKeys(parsePrefix('<'))).toBe('<lt>');
  expect(prefixNvimKeys(parsePrefix('`'))).toBe('`');
  expect(prefixNvimKeys(parsePrefix('C-Space'))).toBe('<C-Space>');
  expect(prefixNvimKeys(parsePrefix('C-Enter'))).toBe('<C-CR>');
  expect(prefixNvimKeys(parsePrefix('F5'))).toBe('<F5>');
});
