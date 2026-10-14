import { NVIM_SPECIAL_KEYS } from './nvimKeys';

export interface ParsedKey {
  ctrl: boolean;
  alt: boolean;
  /** `KeyboardEvent.key` value: `' '` for Space, `Enter`, `F5`, or one character. */
  key: string;
}

/** Named keys, as `KeyboardEvent.key` names with `Space` for " ". Mirrors `PREFIX_KEY_NAMES` in config.rs. */
const NAMED_KEYS = [
  'Space',
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

/** Parse a tmux-style prefix (`C-a`, `M-x`, `C-Space`), or null if it isn't one. Mirrors `parse_prefix` in config.rs. */
export function parsePrefix(prefix: string): ParsedKey | null {
  let rest = prefix.trim();
  let ctrl = false;
  let alt = false;
  while (rest.length > 2 && rest[1] === '-') {
    const mod = rest[0].toUpperCase();
    if (mod === 'C' && !ctrl) ctrl = true;
    else if (mod === 'M' && !alt) alt = true;
    else if (mod === 'C' || mod === 'M') return null;
    else break;
    rest = rest.slice(2);
  }
  if ([...rest].length === 1) {
    return /^[\p{Cc}\s]$/u.test(rest) ? null : { ctrl, alt, key: rest };
  }
  const fkey = rest.match(/^[Ff]([1-9]|1[0-2])$/);
  if (fkey) return { ctrl, alt, key: `F${fkey[1]}` };
  const named = NAMED_KEYS.find((name) => name.toLowerCase() === rest.toLowerCase());
  if (!named) return null;
  return { ctrl, alt, key: named === 'Space' ? ' ' : named };
}

/** Error message for an invalid prefix, or null if it's valid. */
export function prefixError(prefix: string): string | null {
  return parsePrefix(prefix) ? null : 'Use optional C- or M- modifiers and one key, such as C-a, M-x, C-Space, or F12.';
}

const PHYSICAL_KEY = /^(?:Key([A-Z])|Digit(\d))$/;

export function matchesPrefix(e: KeyboardEvent, p: ParsedKey): boolean {
  if (e.ctrlKey !== p.ctrl || e.altKey !== p.alt) return false;
  // macOS Option+Space types U+00A0.
  if (p.key === ' ') return e.key === ' ' || e.code === 'Space';
  if (p.key.length > 1) return e.key === p.key;
  const fold = p.ctrl || p.alt;
  const same = (key: string) => (fold ? key.toLowerCase() === p.key.toLowerCase() : key === p.key);
  if (same(e.key)) return true;
  // macOS Option composes characters (Option+x is "≈"); use the physical key.
  const physical = p.alt ? e.code.match(PHYSICAL_KEY) : null;
  return !!physical && same(physical[1] ?? physical[2]);
}

const PLAIN_BYTES: Record<string, string> = { ' ': ' ', Enter: '\r', Tab: '\t', Escape: '\x1b', Backspace: '\x7f' };

/** Terminal bytes for the prefix chord: Ctrl+letter → control char, Alt → ESC prefix. */
export function prefixBytes(p: ParsedKey): string | null {
  let text: string | undefined = p.key;
  if (p.ctrl) {
    if (text === ' ') {
      text = '\x00';
    } else {
      if (text.length !== 1) return null;
      const code = text.toUpperCase().charCodeAt(0);
      if (code < 0x40 || code > 0x5f) return null;
      text = String.fromCharCode(code & 0x1f);
    }
  } else if (text.length !== 1) {
    text = PLAIN_BYTES[text];
    if (!text) return null;
  }
  return p.alt ? `\x1b${text}` : text;
}

/** Neovim key notation for the prefix chord (`<C-a>`, `<M-b>`, `<C-Space>`), for `nvim_input`. */
export function prefixNvimKeys(p: ParsedKey): string | null {
  const mods = (p.ctrl ? 'C-' : '') + (p.alt ? 'M-' : '');
  const special = NVIM_SPECIAL_KEYS[p.key] ?? (/^F\d+$/.test(p.key) ? p.key : undefined);
  if (special) return `<${mods}${special}>`;
  if ([...p.key].length !== 1) return null;
  const key = p.key === '<' ? 'lt' : p.key;
  return mods || key === 'lt' ? `<${mods}${key}>` : key;
}
