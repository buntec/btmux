// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { stepIndex } from './src/lib/utils';

test('steps within the list', () => {
  expect(stepIndex(1, 1, 3, true)).toBe(2);
  expect(stepIndex(1, -1, 3, true)).toBe(0);
});

test('wraps a step past either end', () => {
  expect(stepIndex(2, 1, 3, true)).toBe(0);
  expect(stepIndex(0, -1, 3, true)).toBe(2);
});

test('clamps without wrap', () => {
  expect(stepIndex(2, 1, 3, false)).toBe(2);
  expect(stepIndex(0, -1, 3, false)).toBe(0);
  expect(stepIndex(1, 5, 3, true)).toBe(2);
  expect(stepIndex(1, -5, 3, true)).toBe(0);
});

test('handles empty and stale indices', () => {
  expect(stepIndex(0, 1, 0, true)).toBe(0);
  expect(stepIndex(7, 1, 3, true)).toBe(0);
  expect(stepIndex(7, -1, 3, false)).toBe(2);
});
