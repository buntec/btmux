// Neovim 'guifont' → CSS font, in the format GUIs like Neovide use:
// comma-separated families with ':'-separated options, e.g. "JetBrains Mono,Symbols Nerd Font:h14".

export interface GuiFont {
  /** CSS font-family list, or null to keep the btmux font. */
  families: string[];
  /** CSS pixels, or null to keep the btmux size. */
  size: number | null;
}

/** Points to CSS pixels (CSS defines 1pt as 4/3px). */
const PT_TO_PX = 4 / 3;

export function parseGuifont(value: string): GuiFont {
  const families: string[] = [];
  let size: number | null = null;
  // Split on commas not escaped with a backslash.
  for (const entry of value.split(/(?<!\\),/)) {
    const [name, ...options] = entry.replace(/\\,/g, ',').split(':');
    // Vim GUIs accept "_" for spaces; "*" means "pick a font", i.e. the default.
    const family = name.replace(/\\ /g, ' ').replace(/_/g, ' ').trim();
    if (family && family !== '*') families.push(family);
    for (const option of options) {
      const height = option.match(/^h(\d+(?:\.\d+)?)$/);
      if (height) size = Math.round(Number(height[1]) * PT_TO_PX * 100) / 100;
    }
  }
  return { families, size };
}

/** Quote a family name for a CSS font-family list. */
export function cssFamily(name: string): string {
  return /^[\w-]+$/.test(name) && !/^\d/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}
