// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { moveId, sortByAgentGridOrder } from './src/state/agentGridOrder';

const sort = (ids: string[], order: string[]) => sortByAgentGridOrder(ids, (id) => id, order);

test('saved panes first, new panes keep their order after them', () => {
  expect(sort(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  expect(sort(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('moveId lands the item at the target index', () => {
  expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  expect(moveId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
});
