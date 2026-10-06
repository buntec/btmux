// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { findMatches, viewportYFor, type SearchRow } from './src/lib/terminalSearch';

const rows = (...lines: string[]): SearchRow[] => lines.map((text) => ({ text, cols: null }));

test('lowercase queries ignore case; uppercase queries are exact', () => {
  const r = rows('Error: boom', 'an error', 'ERROR');
  expect(findMatches(r, 'error').map((m) => m.line)).toEqual([0, 1, 2]);
  expect(findMatches(r, 'Error').map((m) => m.line)).toEqual([0]);
});

test('finds repeated, non-overlapping matches in one line', () => {
  expect(findMatches(rows('aaaa'), 'aa').map((m) => m.column)).toEqual([0, 2]);
});

test('maps string indices through wide-character columns', () => {
  // "あb": あ occupies columns 0-1, b is column 2.
  const r: SearchRow[] = [{ text: 'あb', cols: [0, 2] }];
  expect(findMatches(r, 'b')).toEqual([{ line: 0, column: 2, length: 1 }]);
});

test('empty query matches nothing', () => {
  expect(findMatches(rows('abc'), '')).toEqual([]);
});

test('viewportYFor centers a line', () => {
  // 100 lines, 24 visible: line 50 at the middle row means top = 38,
  // so 100 - 24 - 38 = 38 lines scrolled back.
  expect(viewportYFor(50, 100, 24)).toBe(38);
});
