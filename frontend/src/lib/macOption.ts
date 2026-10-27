// macOS Option: text the layout types with it, or Meta.

type KeyInit = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/** The letter or digit printed on the physical key, or null. */
export function physicalKey(e: KeyInit): string | null {
  const m = e.code.match(/^(?:Key([A-Z])|Digit(\d))$/);
  if (!m) return null;
  return m[1] ? (e.shiftKey ? m[1] : m[1].toLowerCase()) : m[2];
}

/**
 * ASCII text that Option types on this layout (`@`, `[`, `|` on German or
 * Swiss), or null when Option should act as Meta. Pass only macOS events.
 */
export function macOptionText(e: KeyInit): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || !/^[!-~]$/.test(e.key)) return null;
  return e.key.toLowerCase() === physicalKey(e)?.toLowerCase() ? null : e.key;
}
