// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { adjacentSession } from './src/state/sessionNavigation';

const sessions = [
  { id: 'one', name: 'One' },
  { id: 'two', name: 'Two' },
  { id: 'three', name: 'Three' },
];

test('next and previous sessions wrap in server order', () => {
  expect(adjacentSession(sessions, 'two', 1)?.id).toBe('three');
  expect(adjacentSession(sessions, 'two', -1)?.id).toBe('one');
  expect(adjacentSession(sessions, 'three', 1)?.id).toBe('one');
  expect(adjacentSession(sessions, 'one', -1)?.id).toBe('three');
});

test('session cycling is a no-op without a distinct current neighbor', () => {
  expect(adjacentSession(sessions.slice(0, 1), 'one', 1)).toBeNull();
  expect(adjacentSession(sessions, 'missing', 1)).toBeNull();
});
