import type { Theme } from '../state/types';
import { DEFAULT_THEME } from '../state/defaultTheme';

// The btmux chrome — status bar, pane title bars, command/help/switcher overlays —
// is styled after the "btmux Chrome" design mock. That mock hardcodes a teal +
// orange palette over teal-tinted darks, but btmux is theme-driven: colors follow
// the user's base16/base24 config. This module maps the mock's palette roles onto
// the resolved `Theme` so the chrome recolors with any theme while keeping the
// design's structure and contrast relationships.

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace('#', '');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

function toHex(r: number, g: number, b: number): string {
  return `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g)
    .toString(16)
    .padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;
}

/** Perceived luminance of a hex color (0–255). */
function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

/** Return `color` with the given alpha as an `rgba()` string. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Linear blend of two hex colors: `t=0` → `a`, `t=1` → `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

/**
 * Nudge a color's brightness by `amount`, luminance-aware: dark colors get
 * lighter, light colors get darker. Used to lift the background into the
 * slightly-raised chrome surfaces (status bar, pane title bars).
 */
export function lift(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const dir = luminance(hex) > 128 ? -amount : amount;
  return toHex(rgb[0] + dir, rgb[1] + dir, rgb[2] + dir);
}

export interface ChromePalette {
  /** Primary accent (active pane, session segment, window index badge). */
  accent: string;
  /** Ink color for text/icons sitting on an accent fill. */
  accentInk: string;
  /** Faint accent halo for glow rings / shadows. */
  accentGlow: string;
  /** Warm accent for the prefix indicator. */
  warn: string;
  /** Ink color for text on the warm fill. */
  warnInk: string;
  /** Zoom indicator accent. */
  zoom: string;
  /** App/body background. */
  bodyBg: string;
  /** Slightly-raised surface for the status bar and inactive title bars. */
  barBg: string;
  /** Elevated surface for centered overlays/modals. */
  panelBg: string;
  /** Mid-tone fill for the active window segment and active pane title bar. */
  titleActiveBg: string;
  /** Fill for inactive pane title bars. */
  titleInactiveBg: string;
  /** Primary structural border. */
  border: string;
  /** Dimmer structural border / hairline. */
  borderDim: string;
  /** Selected-row highlight background. */
  selBg: string;
  /** Primary text. */
  fg: string;
  /** Brightest text (headings, active labels). */
  fgBright: string;
  /** Muted text (secondary labels). */
  fgMuted: string;
  /** Dimmest text (hints, meta). */
  fgDim: string;
}

/**
 * Derive the chrome palette from the resolved theme (falling back to the
 * built-in default theme for any unset field).
 */
export function chromePalette(theme: Theme | null): ChromePalette {
  const t = theme ?? DEFAULT_THEME;
  const accent = t.blue;
  const bodyBg = t.background;
  const barBg = lift(bodyBg, 10);
  const border = t.selectionBackground;

  return {
    accent,
    accentInk: bodyBg,
    accentGlow: withAlpha(accent, 0.2),
    warn: t.yellow,
    warnInk: bodyBg,
    zoom: t.magenta,
    bodyBg,
    barBg,
    panelBg: lift(bodyBg, 6),
    titleActiveBg: mix(barBg, accent, 0.26),
    titleInactiveBg: lift(bodyBg, 16),
    border,
    borderDim: mix(border, bodyBg, 0.5),
    selBg: t.selectionBackground,
    fg: t.foreground,
    fgBright: t.brightWhite,
    fgMuted: t.brightBlack,
    fgDim: mix(t.brightBlack, bodyBg, 0.4),
  };
}
