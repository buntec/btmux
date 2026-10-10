// Browser keyboard events → Neovim `nvim_input` key notation.

const SPECIAL: Record<string, string> = {
  Enter: 'CR',
  Escape: 'Esc',
  Backspace: 'BS',
  Tab: 'Tab',
  Delete: 'Del',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
};

/** Cmd shortcuts the browser or desktop app keeps (Cmd+V arrives as a paste event). */
const RESERVED_CMD_KEYS = new Set(['q', 'w', 't', 'n', 'r', 'l', 'm', 'h', 'v']);

/** Escape literal text for `nvim_input`, where `<` starts a key name. */
export function escapeNvimText(text: string): string {
  return text.replace(/</g, '<lt>');
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Key notation for `e`, or null when the browser should handle it (modifiers, IME, app shortcuts). */
export function nvimKey(e: KeyboardEvent, mac = IS_MAC): string | null {
  if (e.isComposing || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return null;
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;

  let key = e.key;
  // AltGr produces text, even when the browser also reports Ctrl and Alt.
  if (e.getModifierState?.('AltGraph') && [...key].length === 1 && !e.metaKey) return escapeNvimText(key);
  // Cmd (`<D-…>`, as in Neovide) for anything the browser doesn't need.
  if (e.metaKey) {
    const physical = e.code.match(/^(?:Key([A-Z])|Digit(\d))$/);
    if (physical?.[2] || RESERVED_CMD_KEYS.has((physical?.[1] ?? key).toLowerCase())) return null;
    if (physical?.[1]) key = e.shiftKey ? physical[1] : physical[1].toLowerCase();
  }
  // macOS Option produces composed characters; use the physical key instead,
  // unless the layout types ASCII with it (`@`, `[`, `|` on German or French).
  if (e.altKey) {
    const m = e.code.match(/^(?:Key([A-Z])|Digit(\d))$/);
    const physical = m && (m[1] ? (e.shiftKey ? m[1] : m[1].toLowerCase()) : m[2]);
    if (mac && !e.ctrlKey && !e.metaKey && /^[!-~]$/.test(key) && key.toLowerCase() !== physical?.toLowerCase()) {
      return escapeNvimText(key);
    }
    if (physical) key = physical;
  }

  const fkey = /^F\d{1,2}$/.test(key);
  const special = SPECIAL[key] ?? (fkey ? key : undefined);
  if (special === undefined && key.length !== 1 && [...key].length !== 1) return null;

  // Shift is already folded into printable characters.
  const mods =
    (e.ctrlKey ? 'C-' : '') + (e.altKey ? 'M-' : '') + (e.metaKey ? 'D-' : '') + (e.shiftKey && special ? 'S-' : '');
  if (special !== undefined) {
    if (!mods && key === ' ') return ' ';
    return `<${mods}${special}>`;
  }
  if (key === '<') return mods ? `<${mods}lt>` : '<lt>';
  return mods ? `<${mods}${key}>` : key;
}
