import type { ColorMode } from '../state/types';

/** Short name for a color scheme given as a path or URL. */
export function colorSchemeLabel(value: string): string {
  return value.includes('/')
    ? value
        .replace(/\/+$/, '')
        .split('/')
        .pop()!
        .replace(/\.ya?ml$/i, '')
    : value;
}

/** Bundled schemes used when `colors-dark`/`colors-light` is unset (mirror config.rs). */
export const DEFAULT_COLOR_SCHEMES: Record<ColorMode, string> = {
  dark: 'btmux-default-dark',
  light: 'btmux-default-light',
};
