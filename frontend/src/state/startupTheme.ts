import type { Theme } from './types';

// First-paint fallback before the server's config arrives; mirrors the
// bundled default in extras/colors/btmux-default-dark.yml (checked by a Rust test).
export const FALLBACK_THEME: Theme = {
  background: '#14110b',
  foreground: '#b5b1a5',
  cursor: '#b5b1a5',
  cursorAccent: '#14110b',
  selectionBackground: '#363329',
  black: '#14110b',
  red: '#f29199',
  green: '#80c490',
  yellow: '#cbaf53',
  blue: '#84b5eb',
  magenta: '#da96d6',
  cyan: '#59c6bc',
  white: '#b5b1a5',
  brightBlack: '#5c584c',
  brightRed: '#ffacb3',
  brightGreen: '#92e0a5',
  brightYellow: '#e9c85e',
  brightBlue: '#97d0ff',
  brightMagenta: '#f9abf5',
  brightCyan: '#65e2d7',
  brightWhite: '#efebe1',
};

function readStartupTheme(): Theme {
  try {
    const cached = JSON.parse(localStorage.getItem('btmux-theme') ?? 'null');
    if (cached && Object.keys(FALLBACK_THEME).every((key) => typeof cached[key] === 'string')) return cached;
  } catch {}
  return FALLBACK_THEME;
}

export const STARTUP_THEME = readStartupTheme();
