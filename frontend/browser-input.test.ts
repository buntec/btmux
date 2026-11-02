import { expect, test } from 'bun:test';
import { addressToUrl, buttonName, containRect, keyMessage, modifierBits } from './src/lib/browserInput';

const key = { key: 'a', code: 'KeyA', keyCode: 65, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

test('address bar text becomes a URL or a search', () => {
  expect(addressToUrl('https://example.com/a')).toBe('https://example.com/a');
  expect(addressToUrl('about:blank')).toBe('about:blank');
  expect(addressToUrl('example.com')).toBe('https://example.com');
  expect(addressToUrl('localhost:5173/x')).toBe('http://localhost:5173/x');
  expect(addressToUrl('127.0.0.1')).toBe('http://127.0.0.1');
  expect(addressToUrl('[::1]:3000')).toBe('http://[::1]:3000');
  expect(addressToUrl('devbox:8080')).toBe('http://devbox:8080');
  expect(addressToUrl('printer.local')).toBe('http://printer.local');
  expect(addressToUrl('tmux')).toBe('https://duckduckgo.com/?q=tmux');
  expect(addressToUrl('what is tmux.conf')).toBe('https://duckduckgo.com/?q=what%20is%20tmux.conf');
});

test('keys carry text only when they type', () => {
  expect(keyMessage(key, true)).toMatchObject({ text: 'a', modifiers: 0, down: true });
  expect(keyMessage(key, false).type === 'key' && keyMessage(key, false)).toMatchObject({ text: null });
  expect(keyMessage({ ...key, ctrlKey: true }, true)).toMatchObject({ text: null, modifiers: 2 });
  expect(keyMessage({ ...key, metaKey: true }, true)).toMatchObject({ text: null, modifiers: 4 });
  expect(keyMessage({ ...key, key: 'Enter', code: 'Enter', keyCode: 13 }, true)).toMatchObject({ text: '\r' });
  expect(keyMessage({ ...key, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, true)).toMatchObject({ text: null });
  expect(keyMessage({ ...key, key: 'å', altKey: true }, true)).toMatchObject({ text: 'å', modifiers: 1 });
});

test('modifiers and buttons use CDP values', () => {
  expect(modifierBits({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  expect([0, 1, 2, 3].map(buttonName)).toEqual(['left', 'middle', 'right', 'none']);
});

test('a frame letterboxes in a box of another shape', () => {
  expect(containRect(800, 600, 400, 300)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  expect(containRect(800, 600, 600, 600)).toEqual({ left: 100, top: 0, width: 600, height: 600 });
  expect(containRect(800, 600, 0, 0)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
});
