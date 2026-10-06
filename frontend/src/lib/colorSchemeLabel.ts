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

/** Bundled scheme used when `colors` is unset (mirrors DEFAULT_COLOR_SCHEME in config.rs). */
export const DEFAULT_COLOR_SCHEME = 'btmux-default-dark';
