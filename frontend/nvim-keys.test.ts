// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { escapeNvimText, nvimKey } from './src/lib/nvimKeys';

type Init = Partial<Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>>;

const key = (init: Init) =>
  nvimKey({
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...init,
  } as KeyboardEvent);

test('printable characters pass through, with < escaped', () => {
  expect(key({ key: 'a' })).toBe('a');
  expect(key({ key: 'A', shiftKey: true })).toBe('A');
  expect(key({ key: 'ü' })).toBe('ü');
  expect(key({ key: '<' })).toBe('<lt>');
  expect(key({ key: ' ' })).toBe(' ');
});

test('special keys map to key notation', () => {
  expect(key({ key: 'Enter' })).toBe('<CR>');
  expect(key({ key: 'Escape' })).toBe('<Esc>');
  expect(key({ key: 'Backspace' })).toBe('<BS>');
  expect(key({ key: 'Tab' })).toBe('<Tab>');
  expect(key({ key: 'ArrowLeft' })).toBe('<Left>');
  expect(key({ key: 'PageDown' })).toBe('<PageDown>');
  expect(key({ key: 'F5' })).toBe('<F5>');
  expect(key({ key: 'F12' })).toBe('<F12>');
});

test('modifiers wrap keys; shift only applies to special keys', () => {
  expect(key({ key: 'a', ctrlKey: true })).toBe('<C-a>');
  expect(key({ key: '<', ctrlKey: true })).toBe('<C-lt>');
  expect(key({ key: ' ', ctrlKey: true })).toBe('<C-Space>');
  expect(key({ key: 'Tab', shiftKey: true })).toBe('<S-Tab>');
  expect(key({ key: 'ArrowUp', ctrlKey: true, shiftKey: true })).toBe('<C-S-Up>');
  expect(key({ key: 'Enter', altKey: true })).toBe('<M-CR>');
});

test('macOS Option uses the physical key, not the composed character', () => {
  expect(key({ key: 'å', code: 'KeyA', altKey: true })).toBe('<M-a>');
  expect(key({ key: 'Å', code: 'KeyA', altKey: true, shiftKey: true })).toBe('<M-A>');
  expect(key({ key: '¡', code: 'Digit1', altKey: true })).toBe('<M-1>');
});

test('Cmd sends <D-…>, except shortcuts the browser or app keeps', () => {
  expect(key({ key: 's', code: 'KeyS', metaKey: true })).toBe('<D-s>');
  expect(key({ key: 'S', code: 'KeyS', metaKey: true, shiftKey: true })).toBe('<D-S>');
  expect(key({ key: 'c', code: 'KeyC', metaKey: true })).toBe('<D-c>');
  expect(key({ key: 'Enter', code: 'Enter', metaKey: true })).toBe('<D-CR>');
  expect(key({ key: 'F5', code: 'F5', metaKey: true })).toBe('<D-F5>');
  for (const letter of ['q', 'w', 't', 'n', 'r', 'l', 'm', 'h', 'v']) {
    expect(key({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true })).toBeNull();
  }
  expect(key({ key: '1', code: 'Digit1', metaKey: true })).toBeNull();
});

test('leaves modifiers, IME, dead keys and Cmd+V to the browser', () => {
  for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'Dead', 'Process', 'Unidentified', 'CapsLock']) {
    expect(key({ key: k })).toBeNull();
  }
  expect(key({ key: 'a', isComposing: true })).toBeNull();
  expect(key({ key: 'v', code: 'KeyV', metaKey: true })).toBeNull();
});

test('escapes literal text for nvim_input', () => {
  expect(escapeNvimText('a<b>c')).toBe('a<lt>b>c');
  expect(escapeNvimText('<<')).toBe('<lt><lt>');
  expect(escapeNvimText('plain')).toBe('plain');
});
