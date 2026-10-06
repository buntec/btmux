export interface ParsedKey {
  ctrl: boolean;
  alt: boolean;
  key: string;
}

export function parsePrefix(prefix: string): ParsedKey {
  const parts = prefix.split('-');
  const key = (parts.pop() ?? '').toLowerCase();
  const mods = new Set(parts.map((p) => p.toUpperCase()));
  return { ctrl: mods.has('C'), alt: mods.has('M'), key };
}

/** Terminal bytes for the prefix chord: Ctrl+letter → control char, Alt → ESC prefix. */
export function prefixBytes(p: ParsedKey): string | null {
  let text = p.key;
  if (p.ctrl) {
    if (text.length !== 1) return null;
    const code = text.toUpperCase().charCodeAt(0);
    if (code < 0x40 || code > 0x5f) return null;
    text = String.fromCharCode(code & 0x1f);
  } else if (text.length !== 1) {
    return null;
  }
  return p.alt ? `\x1b${text}` : text;
}
