import { expect, test } from 'bun:test';
import { filterPick, pickHaystack } from './src/lib/pickFilter';

const items = ['checkout', 'cherry-pick', 'rebase', 'switch'].map((label) => pickHaystack({ label, description: null }));

test('an empty query keeps input order', () => {
  expect(filterPick(items, '  ', 10)).toEqual({ indices: [0, 1, 2, 3], total: 4 });
});

test('label prefixes rank first', () => {
  const haystacks = ['a-che', 'che-b', 'c-che'];
  expect(filterPick(haystacks, 'che', 10).indices).toEqual([1, 0, 2]);
});

test('every term must match, ignoring case', () => {
  expect(filterPick(items, 'CHE pick', 10).indices).toEqual([1]);
  expect(filterPick(items, 'che zzz', 10).total).toBe(0);
});

test('descriptions match but do not count as prefixes', () => {
  const haystacks = [pickHaystack({ label: 'x', description: 'Note' }), pickHaystack({ label: 'note', description: null })];
  expect(filterPick(haystacks, 'note', 10).indices).toEqual([1, 0]);
});

test('the limit keeps the total', () => {
  expect(filterPick(items, '', 2)).toEqual({ indices: [0, 1], total: 4 });
});
