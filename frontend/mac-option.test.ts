// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { macOptionText } from './src/lib/macOption';

const text = (init: Partial<Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'metaKey'>>) =>
  macOptionText({ key: '', code: '', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, ...init });

test('Option keeps ASCII text that the layout types with it', () => {
  expect(text({ key: '@', code: 'KeyG' })).toBe('@');
  expect(text({ key: '#', code: 'Digit3' })).toBe('#');
  expect(text({ key: '\\', code: 'Digit7', shiftKey: true })).toBe('\\');
  expect(text({ key: '[', code: 'Digit5' })).toBe('[');
});

test('Option acts as Meta otherwise', () => {
  expect(text({ key: '∫', code: 'KeyB' })).toBeNull();
  expect(text({ key: 'b', code: 'KeyB' })).toBeNull();
  expect(text({ key: 'B', code: 'KeyB', shiftKey: true })).toBeNull();
  expect(text({ key: '@', code: 'KeyG', ctrlKey: true })).toBeNull();
  expect(text({ key: '@', code: 'KeyG', metaKey: true })).toBeNull();
  expect(
    macOptionText({ key: '@', code: 'KeyG', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
  ).toBeNull();
});
