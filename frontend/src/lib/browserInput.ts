import type { BrowserClientMessage } from '../generated/protocol';
import type { ParsedKey } from './prefixKey';

const DEFAULT_SEARCH_URL = 'https://duckduckgo.com/?q=%s';

type Modifiers = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** CDP's input modifier bits. */
export function modifierBits(e: Modifiers): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** A DOM mouse button as CDP names it. */
export function buttonName(button: number): 'left' | 'middle' | 'right' | 'none' {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none';
}

/** The text a key types, which CDP needs to insert it. */
function keyText(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): string | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Enter') return '\r';
  return [...e.key].length === 1 ? e.key : null;
}

/** A key whose text arrives through `input` once the browser handles it: dead keys, IMEs, phone keyboards, and AltGr. */
export function leftToComposition(
  e: Pick<KeyboardEvent, 'key' | 'isComposing'> & { getModifierState?: KeyboardEvent['getModifierState'] },
): boolean {
  if (e.isComposing || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') return true;
  // AltGr reports Ctrl+Alt on Windows, but types a character.
  return !!e.getModifierState?.('AltGraph') && [...e.key].length === 1;
}

/** A chord the tab's browser turns into a `paste` event, which has the client's clipboard. */
export function isPasteChord(
  e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  isMac: boolean,
): boolean {
  if (e.altKey) return false;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Insert') return true;
  return e.key.toLowerCase() === 'v' && (isMac ? e.metaKey : e.ctrlKey);
}

const NAMED_KEY_CODES: Record<string, number> = {
  ' ': 32,
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Insert: 45,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
};

/** Pressing and releasing the prefix key (`prefix prefix`). */
export function prefixKeyMessages(p: ParsedKey): BrowserClientMessage[] {
  const letter = /^[a-z]$/i.test(p.key);
  const digit = /^\d$/.test(p.key);
  const event = {
    key: p.key,
    code: letter
      ? `Key${p.key.toUpperCase()}`
      : digit
        ? `Digit${p.key}`
        : p.key === ' '
          ? 'Space'
          : p.key.length > 1
            ? p.key
            : '',
    keyCode: NAMED_KEY_CODES[p.key] ?? (letter || digit ? p.key.toUpperCase().charCodeAt(0) : 0),
    repeat: false,
    altKey: p.alt,
    ctrlKey: p.ctrl,
    metaKey: false,
    shiftKey: false,
  };
  return [keyMessage(event, true), keyMessage(event, false)];
}

export function keyMessage(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'repeat'> & Modifiers,
  down: boolean,
): BrowserClientMessage {
  return {
    type: 'key',
    down,
    key: e.key,
    code: e.code,
    key_code: e.keyCode,
    text: down ? keyText(e) : null,
    modifiers: modifierBits(e),
    repeat: e.repeat,
  };
}

/** Where a frame sits in a canvas box under `object-fit: contain`. */
export function containRect(boxWidth: number, boxHeight: number, frameWidth: number, frameHeight: number) {
  if (frameWidth <= 0 || frameHeight <= 0) return { left: 0, top: 0, width: boxWidth, height: boxHeight };
  const scale = Math.min(boxWidth / frameWidth, boxHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

/** What an address bar makes of typed text: a URL, or else a search. */
export function addressToUrl(input: string, searchUrl = DEFAULT_SEARCH_URL): string {
  const text = input.trim();
  const search = () => searchUrl.split('%s').join(encodeURIComponent(text));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|chrome):/i.test(text)) return text;
  if (/\s/.test(text)) return search();
  const host = text.split(/[/?#]/)[0];
  if (/^(localhost|\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+)(:\d+)?$/i.test(host) || /^[^.]+\.local(:\d+)?$/i.test(host)) {
    return `http://${text}`;
  }
  if (/:\d+$/.test(host)) return `http://${text}`;
  return host.includes('.') ? `https://${text}` : search();
}
