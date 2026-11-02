import type { BrowserClientMessage } from '../generated/protocol';

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
export function addressToUrl(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|chrome):/i.test(text)) return text;
  if (/\s/.test(text)) return search(text);
  const host = text.split(/[/?#]/)[0];
  if (/^(localhost|\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+)(:\d+)?$/i.test(host) || /^[^.]+\.local(:\d+)?$/i.test(host)) {
    return `http://${text}`;
  }
  if (/:\d+$/.test(host)) return `http://${text}`;
  return host.includes('.') ? `https://${text}` : search(text);
}

function search(text: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}
