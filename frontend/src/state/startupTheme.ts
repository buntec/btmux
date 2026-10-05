import type { Theme } from './types';

// First-paint fallback before the server's config arrives; mirrors the
// bundled default in extras/colors/kauz-dark.yml.
export const FALLBACK_THEME: Theme = {
  background: '#0e333e',
  foreground: '#8cb3bf',
  cursor: '#8cb3bf',
  cursorAccent: '#0e333e',
  selectionBackground: '#406470',
  black: '#0e333e',
  red: '#e6b8c5',
  green: '#a0d3c8',
  yellow: '#b9c6eb',
  blue: '#e6bcaa',
  magenta: '#d4bde0',
  cyan: '#d4c69e',
  white: '#8cb3bf',
  brightBlack: '#597e8a',
  brightRed: '#ffd4e1',
  brightGreen: '#bcefe4',
  brightYellow: '#d6e2ff',
  brightBlue: '#ffd8c5',
  brightMagenta: '#f1d8fc',
  brightCyan: '#f1e2ba',
  brightWhite: '#c3eaf8',
};

function readStartupTheme(): Theme {
  try {
    const cached = JSON.parse(localStorage.getItem('btmux-theme') ?? 'null');
    if (cached && Object.keys(FALLBACK_THEME).every((key) => typeof cached[key] === 'string')) return cached;
  } catch {}
  return FALLBACK_THEME;
}

export const STARTUP_THEME = readStartupTheme();
