import type { Appearance, ColorMode, Theme } from './types';

// First-paint fallbacks before the server's config arrives; mirror the bundled
// defaults in extras/colors/btmux-default-{dark,light}.yml (checked by a Rust test).
export const FALLBACK_DARK_THEME: Theme = {
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

export const FALLBACK_LIGHT_THEME: Theme = {
  background: '#fcf8ee',
  foreground: '#4b473d',
  cursor: '#4b473d',
  cursorAccent: '#fcf8ee',
  selectionBackground: '#cfcabe',
  black: '#fcf8ee',
  red: '#a74f58',
  green: '#3c7f50',
  yellow: '#876b00',
  blue: '#4272a4',
  magenta: '#935490',
  cyan: '#007f77',
  white: '#4b473d',
  brightBlack: '#8b8679',
  brightRed: '#993745',
  brightGreen: '#1e6f3b',
  brightYellow: '#755a00',
  brightBlue: '#2a6097',
  brightMagenta: '#843e82',
  brightCyan: '#006f68',
  brightWhite: '#1b1811',
};

export const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The color mode this browser's system prefers. */
export function systemColorMode(): ColorMode {
  return window.matchMedia?.(SYSTEM_LIGHT_QUERY).matches ? 'light' : 'dark';
}

/** Remember the appearance and both themes, so the next load paints the right one. */
export function cacheThemes(appearance: Appearance, dark: Theme, light: Theme) {
  try {
    localStorage.setItem('btmux-appearance', appearance);
    localStorage.setItem('btmux-theme-dark', JSON.stringify(dark));
    localStorage.setItem('btmux-theme-light', JSON.stringify(light));
  } catch {}
}

function readStartupTheme(): Theme {
  try {
    const appearance = localStorage.getItem('btmux-appearance');
    const mode = appearance === 'dark' || appearance === 'light' ? appearance : systemColorMode();
    const fallback = mode === 'light' ? FALLBACK_LIGHT_THEME : FALLBACK_DARK_THEME;
    const cached = JSON.parse(localStorage.getItem(`btmux-theme-${mode}`) ?? 'null');
    if (cached && Object.keys(fallback).every((key) => typeof cached[key] === 'string')) return cached;
    return fallback;
  } catch {
    return FALLBACK_DARK_THEME;
  }
}

export const STARTUP_THEME = readStartupTheme();
