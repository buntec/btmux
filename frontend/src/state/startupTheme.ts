import { DEFAULT_THEME } from './defaultTheme';
import type { Theme } from './types';

function readStartupTheme(): Theme {
  try {
    const cached = JSON.parse(localStorage.getItem('btmux-theme') ?? 'null');
    if (cached && Object.keys(DEFAULT_THEME).every((key) => typeof cached[key] === 'string')) return cached;
  } catch {}
  return DEFAULT_THEME;
}

export const STARTUP_THEME = readStartupTheme();
