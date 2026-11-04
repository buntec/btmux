import type { CSSProperties } from 'react';
import { defineTheme, type TokenName, type TokenValue } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral';
import type { BaseTheme, Theme } from '../state/types';
import { mix, withAlpha } from './chrome-colors';

function luminance(color: string): number {
  const channels = color
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels?.length === 3 ? channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 : 0;
}

export function contrastRatio(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function readableColor(color: string, background: string, minimum = 4.5): string {
  if (contrastRatio(color, background) >= minimum) return color;
  const target = contrastRatio('#ffffff', background) > contrastRatio('#000000', background) ? '#ffffff' : '#000000';
  for (let amount = 0.05; amount <= 1; amount += 0.05) {
    const candidate = mix(color, target, amount);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return target;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklch(color: string): [number, number, number] {
  const [r, g, b] = (color.replace('#', '').match(/.{2}/g) ?? []).map((c) => toLinear(parseInt(c, 16) / 255));
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, b2), Math.atan2(b2, a)];
}

function fromOklch(L: number, C: number, h: number): number[] {
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * A theme hue as a chart mark, at `shade` (0 to 1) of the lightness range for
 * this background. Terminal palettes are often pastel and close in lightness,
 * which colorblind readers can't tell apart.
 */
export function chartColor(color: string, background: string, shade: number): string {
  const dark = contrastRatio('#ffffff', background) > contrastRatio('#000000', background);
  const [low, high] = dark ? [0.5, 0.665] : [0.45, 0.62];
  const target = low + shade * (high - low);
  const [, C, h] = toOklch(color);
  // Reduce chroma only as far as the hue needs to stay in sRGB.
  let chroma = Math.max(C, 0.14);
  let rgb = fromOklch(target, chroma, h);
  while (rgb.some((v) => v < 0 || v > 1) && chroma > 0.102) {
    chroma -= 0.002;
    rgb = fromOklch(target, chroma, h);
  }
  const hex = rgb
    .map((v) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  return readableColor(`#${hex}`, background, 3);
}

export function terminalColorMode(palette: Theme): 'light' | 'dark' {
  return luminance(palette.background) > luminance(palette.foreground) ? 'light' : 'dark';
}

/** The bundled Nerd Font covers icons (e.g. from Neovim) the configured font lacks. */
const FONT_FALLBACKS = 'Symbols Nerd Font Mono, monospace';
const SANS_FALLBACKS = 'system-ui, sans-serif, Symbols Nerd Font Mono';
const UI_SANS = 'Geist Variable';

export function createBtmuxTheme(palette: Theme, fontFamily: string, animations: boolean, scheme?: BaseTheme | null) {
  const background = palette.background;
  const surface = mix(background, palette.foreground, 0.05);
  const popover = mix(background, palette.foreground, 0.08);
  const foreground = readableColor(palette.foreground, popover);
  const secondary = readableColor(mix(foreground, background, 0.25), popover);
  const ink = (fill: string) => readableColor(background, fill);
  const tokens: Partial<Record<TokenName, TokenValue>> = {
    '--color-background-body': background,
    '--color-background-surface': surface,
    '--color-background-card': surface,
    '--color-background-popover': popover,
    '--color-background-muted': mix(background, foreground, 0.08),
    '--color-background-inverted': foreground,
    '--color-text-primary': foreground,
    '--color-text-secondary': secondary,
    '--color-text-disabled': mix(foreground, background, 0.5),
    '--color-icon-primary': foreground,
    '--color-icon-secondary': secondary,
    '--color-icon-disabled': mix(foreground, background, 0.5),
    '--color-accent': palette.blue,
    '--color-accent-muted': mix(background, palette.blue, 0.2),
    '--color-on-accent': ink(palette.blue),
    '--color-text-accent': readableColor(palette.blue, popover),
    '--color-icon-accent': readableColor(palette.blue, popover),
    '--color-border': mix(background, foreground, 0.2),
    '--color-border-emphasized': readableColor(palette.brightBlack, surface, 3),
    // Validated with the dataviz palette checks on the bundled schemes; keep this order and these shades.
    '--color-data-categorical-blue': chartColor(palette.blue, background, 0),
    '--color-data-categorical-green': chartColor(palette.green, background, 1),
    '--color-data-categorical-purple': chartColor(palette.magenta, background, 0.25),
    '--color-data-categorical-cyan': chartColor(palette.cyan, background, 0.75),
    '--color-data-categorical-orange': chartColor(palette.yellow, background, 0.5),
    '--color-neutral': withAlpha(foreground, 0.12),
    '--color-overlay': withAlpha(background, 0.7),
    '--color-overlay-hover': withAlpha(foreground, 0.06),
    '--color-overlay-pressed': withAlpha(foreground, 0.12),
    '--color-tint-hover': foreground,
    '--color-track': mix(background, foreground, 0.3),
    '--color-skeleton': mix(background, foreground, 0.2),
    '--color-shadow': withAlpha(background, 0.4),
  };
  for (const [status, color] of [
    ['success', palette.green],
    ['warning', palette.yellow],
    ['error', palette.red],
  ] as const) {
    tokens[`--color-${status}`] = readableColor(color, popover);
    tokens[`--color-${status}-muted`] = mix(background, color, 0.18);
    tokens[`--color-on-${status}`] = ink(color);
  }
  const colors = {
    blue: palette.blue,
    cyan: palette.cyan,
    gray: palette.brightBlack,
    green: palette.green,
    // base09; base16 bright colors repeat the normal ones.
    orange: scheme?.base09 ?? palette.brightRed,
    pink: palette.magenta,
    purple: palette.brightMagenta,
    red: palette.red,
    teal: palette.brightCyan,
    yellow: palette.yellow,
  };
  for (const [name, color] of Object.entries(colors)) {
    tokens[`--color-background-${name}` as TokenName] = mix(background, color, 0.18);
    tokens[`--color-border-${name}` as TokenName] = readableColor(color, surface, 3);
    tokens[`--color-text-${name}` as TokenName] = readableColor(color, popover);
    tokens[`--color-icon-${name}` as TokenName] = readableColor(color, popover);
  }
  return defineTheme({
    name: 'btmux',
    extends: neutralTheme,
    typography: {
      body: { family: UI_SANS, fallbacks: SANS_FALLBACKS },
      heading: { family: UI_SANS, fallbacks: SANS_FALLBACKS },
      code: { family: fontFamily, fallbacks: FONT_FALLBACKS },
    },
    ...(animations ? {} : { motion: { fast: 0, medium: 0, ratio: 1 } }),
    tokens,
    components: {
      kbd: { base: { fontFamily: 'var(--font-family-code)' } },
      // Palette surfaces instead of the inverted foreground slab.
      toast: {
        base: {
          backgroundColor: 'var(--color-background-popover)',
          border: '1px solid var(--color-border)',
        },
        'type:error': {
          backgroundColor: 'var(--color-error-muted)',
          borderColor: 'var(--color-border-red)',
        },
      },
    },
    localTokens: {
      '--astryx-theme-neutral-color-status-fill-accent': palette.blue,
      '--astryx-theme-neutral-color-status-fill-success': palette.green,
      '--astryx-theme-neutral-color-status-fill-warning': palette.yellow,
      '--astryx-theme-neutral-color-status-fill-error': palette.red,
      '--astryx-theme-neutral-color-status-muted-accent': mix(background, palette.blue, 0.2),
      '--astryx-theme-neutral-color-destructive-overlay-hover': withAlpha(palette.red, 0.06),
      '--astryx-theme-neutral-color-destructive-overlay-pressed': withAlpha(palette.red, 0.12),
    },
  });
}

const TYPE_STEPS = {
  '2xs': -3,
  xs: -2,
  sm: -1,
  base: 0,
  lg: 1,
  xl: 2,
  '2xl': 3,
  '3xl': 4,
  '4xl': 5,
  '5xl': 6,
} as const;
const TEXT_ROLES = {
  body: 'base',
  label: 'base',
  code: 'base',
  large: 'lg',
  supporting: 'sm',
  'heading-1': '2xl',
  'heading-2': 'xl',
  'heading-3': 'lg',
  'heading-4': 'base',
  'heading-5': 'sm',
  'heading-6': 'xs',
} as const;

// Anchors Astryx and Tailwind type tokens to the terminal font size so
// Table/Text/Token content matches inherited-size rows (theme base is 14px).
// Derived `--text-*` tokens are resolved where declared, so redeclare them.
export function terminalTypeScale(fontSize: number): CSSProperties {
  const style: Record<string, string> = { fontSize: `${fontSize}px` };
  for (const [name, step] of Object.entries(TYPE_STEPS)) {
    const size = `${Math.round(fontSize * 1.2 ** step * 100) / 100}px`;
    style[`--font-size-${name}`] = size;
    style[`--text-${name}`] = size;
  }
  for (const [role, name] of Object.entries(TEXT_ROLES)) {
    style[`--text-${role}-size`] = `var(--font-size-${name})`;
  }
  return style as CSSProperties;
}

// Astryx's neutral theme anchors its scale at 14px; modals reset to it.
export const DEFAULT_TYPE_SCALE = terminalTypeScale(14);
