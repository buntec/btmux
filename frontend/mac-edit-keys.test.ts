// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { macEditKey } from './src/lib/macEditKeys';

type Init = Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>>;
const key = (init: Init, mac = true) =>
  macEditKey({ key: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true, ...init }, mac);

test('Cmd editing chords send readline keys', () => {
  expect(key({ key: 'ArrowLeft' })).toBe('\x01');
  expect(key({ key: 'ArrowRight' })).toBe('\x05');
  expect(key({ key: 'Backspace' })).toBe('\x15');
  expect(key({ key: 'Delete' })).toBe('\x0b');
});

test('Shift+Cmd+arrow reports shift+super', () => {
  expect(key({ key: 'ArrowLeft', shiftKey: true })).toBe('\x1b[1;10D');
  expect(key({ key: 'ArrowRight', shiftKey: true })).toBe('\x1b[1;10C');
});

test('other keys and platforms are left alone', () => {
  expect(key({ key: 'ArrowLeft', metaKey: false })).toBeNull();
  expect(key({ key: 'ArrowLeft', altKey: true })).toBeNull();
  expect(key({ key: 'ArrowLeft', ctrlKey: true })).toBeNull();
  expect(key({ key: 'Backspace', shiftKey: true })).toBeNull();
  expect(key({ key: 'ArrowUp' })).toBeNull();
  expect(key({ key: 'c' })).toBeNull();
  expect(key({ key: 'ArrowLeft' }, false)).toBeNull();
});
