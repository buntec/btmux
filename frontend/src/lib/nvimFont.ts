// Neovim 'guifont' → CSS font, in the format GUIs like Neovide use:
// comma-separated families with ':'-separated options, e.g. "JetBrains Mono,Symbols Nerd Font:h14".

export interface GuiFont {
  /** CSS font-family list, or null to keep the btmux font. */
  families: string[];
  /** CSS pixels, or null to keep the btmux size. */
  size: number | null;
  /** `:b` and `:i`: all text bold or italic. */
  bold: boolean;
  italic: boolean;
  /** `:w`: CSS pixels added to the cell width. */
  width: number;
}

/** Points to CSS pixels (CSS defines 1pt as 4/3px). */
const PT_TO_PX = 4 / 3;

export function parseGuifont(value: string): GuiFont {
  const families: string[] = [];
  let size: number | null = null;
  let bold = false;
  let italic = false;
  let width = 0;
  // Split on commas not escaped with a backslash.
  for (const entry of value.split(/(?<!\\),/)) {
    const [name, ...options] = entry.replace(/\\,/g, ',').split(':');
    // Vim GUIs accept "_" for spaces; "*" means "pick a font", i.e. the default.
    const family = name.replace(/\\ /g, ' ').replace(/_/g, ' ').trim();
    if (family && family !== '*') families.push(family);
    for (const option of options) {
      const points = option.match(/^([hw])(-?\d+(?:\.\d+)?)$/);
      const px = points && Math.round(Number(points[2]) * PT_TO_PX * 100) / 100;
      if (points?.[1] === 'h' && px! > 0) size = px;
      else if (points?.[1] === 'w') width = px!;
      else if (option === 'b') bold = true;
      else if (option === 'i') italic = true;
    }
  }
  return { families, size, bold, italic, width };
}

/** Quote a family name for a CSS font-family list. */
export function cssFamily(name: string): string {
  return /^[\w-]+$/.test(name) && !/^\d/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}
