import { expect, test } from 'bun:test';
import {
  addressToUrl,
  buttonName,
  containRect,
  isPasteChord,
  keyMessage,
  leftToComposition,
  modifierBits,
  prefixKeyMessages,
} from './src/lib/browserInput';

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

test('searches use the configured URL', () => {
  const url = 'https://example.com/s?q=%s&again=%s';
  expect(addressToUrl('tmux', url)).toBe('https://example.com/s?q=tmux&again=tmux');
  expect(addressToUrl('a b&c', url)).toBe('https://example.com/s?q=a%20b%26c&again=a%20b%26c');
  expect(addressToUrl('$& x', 'https://example.com/?q=%s')).toBe('https://example.com/?q=%24%26%20x');
  expect(addressToUrl('example.com', url)).toBe('https://example.com');
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

test('keys that compose are left to the browser', () => {
  const event = (key: string, altGraph = false, isComposing = false) => ({ key, isComposing, getModifierState: () => altGraph });
  for (const key of ['Dead', 'Process', 'Unidentified']) expect(leftToComposition(event(key))).toBe(true);
  expect(leftToComposition(event('a', false, true))).toBe(true);
  expect(leftToComposition(event('@', true))).toBe(true);
  expect(leftToComposition(event('€', true))).toBe(true);
  expect(leftToComposition(event('a'))).toBe(false);
  expect(leftToComposition(event('ArrowLeft', true))).toBe(false);
  expect(leftToComposition({ key: 'a', isComposing: false })).toBe(false);
});

test('paste chords depend on the client platform', () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  expect(isPasteChord({ ...none, key: 'v', ctrlKey: true }, false)).toBe(true);
  expect(isPasteChord({ ...none, key: 'V', ctrlKey: true, shiftKey: true }, false)).toBe(true);
  expect(isPasteChord({ ...none, key: 'Insert', shiftKey: true }, false)).toBe(true);
  expect(isPasteChord({ ...none, key: 'v', metaKey: true }, true)).toBe(true);
  // On macOS, Ctrl+V is a key for the page.
  expect(isPasteChord({ ...none, key: 'v', ctrlKey: true }, true)).toBe(false);
  expect(isPasteChord({ ...none, key: 'v' }, false)).toBe(false);
  expect(isPasteChord({ ...none, key: 'v', ctrlKey: true, altKey: true }, false)).toBe(false);
});

test('the prefix key becomes a press and release', () => {
  const [down, up] = prefixKeyMessages({ ctrl: true, alt: false, key: 'a' });
  expect(down).toMatchObject({ type: 'key', down: true, key: 'a', code: 'KeyA', key_code: 65, modifiers: 2, text: null });
  expect(up).toMatchObject({ type: 'key', down: false, key: 'a', modifiers: 2 });
  expect(prefixKeyMessages({ ctrl: true, alt: false, key: ' ' })[0]).toMatchObject({ code: 'Space', key_code: 32 });
  expect(prefixKeyMessages({ ctrl: false, alt: true, key: 'Enter' })[0]).toMatchObject({ code: 'Enter', key_code: 13, modifiers: 1 });
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
