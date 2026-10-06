// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { resizeRatio } from './src/lib/resizePane';
import type { LayoutNode } from './src/state/types';

const leaf = (pane_id: string): LayoutNode => ({ type: 'leaf', pane_id });
const row = (id: string, left: LayoutNode, right: LayoutNode, ratio = 0.5): LayoutNode => ({
  type: 'v_split',
  id,
  ratio,
  left,
  right,
});
const col = (id: string, top: LayoutNode, bottom: LayoutNode, ratio = 0.5): LayoutNode => ({
  type: 'h_split',
  id,
  ratio,
  top,
  bottom,
});
const size = { cols: 100, rows: 50 };

test('right edge of the left pane grows it', () => {
  const r = resizeRatio(row('s', leaf('a'), leaf('b')), 'a', 'right', 5, size);
  expect(r?.splitId).toBe('s');
  expect(r?.ratio).toBeCloseTo(0.5 + 5 / 200, 5);
});

test('left key on the right pane grows it; right key shrinks it', () => {
  const layout = row('s', leaf('a'), leaf('b'));
  expect(resizeRatio(layout, 'b', 'left', 5, { cols: 100, rows: 50 })!.ratio).toBeLessThan(0.5);
  expect(resizeRatio(layout, 'b', 'right', 5, { cols: 100, rows: 50 })!.ratio).toBeGreaterThan(0.5);
});

test('prefers the split whose divider is on the requested side', () => {
  // [[a | b] | c]: right on b moves the outer divider, not the inner one.
  const layout = row('outer', row('inner', leaf('a'), leaf('b')), leaf('c'));
  expect(resizeRatio(layout, 'b', 'right', 1, size)?.splitId).toBe('outer');
  expect(resizeRatio(layout, 'b', 'left', 1, size)?.splitId).toBe('inner');
});

test('ignores splits on the other axis and clamps', () => {
  const layout = col('h', row('v', leaf('a'), leaf('b')), leaf('c'));
  expect(resizeRatio(layout, 'a', 'down', 1, size)?.splitId).toBe('h');
  expect(resizeRatio(layout, 'c', 'right', 1, size)).toBeNull();
  expect(resizeRatio(row('s', leaf('a'), leaf('b'), 0.94), 'a', 'right', 50, size)?.ratio).toBe(0.95);
});

test('pending ratios chain rapid repeats', () => {
  const layout = row('s', leaf('a'), leaf('b'));
  const first = resizeRatio(layout, 'a', 'right', 5, size)!;
  const second = resizeRatio(layout, 'a', 'right', 5, size, new Map([['s', first.ratio]]))!;
  expect(second.ratio).toBeCloseTo(0.5 + 10 / 200, 5);
});
