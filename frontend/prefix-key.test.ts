// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { parsePrefix, prefixBytes, prefixNvimKeys } from './src/lib/prefixKey';

test('Ctrl+letter prefix sends the control character', () => {
  expect(prefixBytes(parsePrefix('C-b'))).toBe('\x02');
  expect(prefixBytes(parsePrefix('C-a'))).toBe('\x01');
});

test('Alt prefix sends ESC plus the key', () => {
  expect(prefixBytes(parsePrefix('M-b'))).toBe('\x1bb');
  expect(prefixBytes(parsePrefix('C-M-b'))).toBe('\x1b\x02');
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
  expect(prefixNvimKeys(parsePrefix('C-Enter'))).toBeNull();
});
