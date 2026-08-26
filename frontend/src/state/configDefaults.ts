import type { ClientConfig, FontEntry } from './types';

/**
 * Defaults used before the first config message arrives and as defensive
 * fallbacks for nullable wire fields. Keep these in step with the backend's
 * config defaults; once connected, ClientConfig remains authoritative.
 */
export const CONFIG_DEFAULTS = {
  prefix: 'C-b',
  animations: true,
  showPaneTitles: false,
  wallpaperShader: 'radiant:aurora-curtain',
  wallpaperOpacity: 0.1,
  wallpaperBlur: 0,
  wallpaperSaturate: 0.05,
  wallpaperSpeed: 0.2,
  wallpaperSeed: 'mellow-nebula-dream',
  wallpaperFollowsMouse: true,
  wallpaperFollowsKeyboard: false,
  paneSwitchIntensity: 0.25,
  paneSwitchDuration: 0.5,
  sessionSort: 'mru' as const,
  windowSort: 'alphabetical' as const,
  windowGridCount: 4,
  terminal: {
    renderer: 'webgl' as const,
    cursorBlink: true,
    cursorStyle: 'bar' as const,
    scrollback: 100_000,
    fontSize: 18,
    fontFamily: 'Geist Mono',
    fontWeight: 400,
    allowTransparency: null,
    convertEol: null,
    disableStdin: null,
    smoothScrollDuration: null,
    scrollSensitivity: 5,
  },
} as const;

export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 72;
export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;
export const DEFAULT_FONT_WEIGHT_MIN = 100;
export const DEFAULT_FONT_WEIGHT_MAX = 900;
export const FONT_WEIGHT_STEP = 100;

type ConfigLike = ClientConfig | null | undefined;

export function getPrefix(config: ConfigLike): string {
  return config?.prefix ?? CONFIG_DEFAULTS.prefix;
}

export function getAnimations(config: ConfigLike): boolean {
  return config?.animations ?? CONFIG_DEFAULTS.animations;
}

export function getShowPaneTitles(config: ConfigLike): boolean {
  return config?.show_pane_titles ?? CONFIG_DEFAULTS.showPaneTitles;
}

export function getTerminalFontSize(config: ConfigLike): number {
  return clamp(config?.terminal.fontSize ?? CONFIG_DEFAULTS.terminal.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE);
}

export function getTerminalFontFamily(config: ConfigLike): string {
  return config?.terminal.fontFamily ?? CONFIG_DEFAULTS.terminal.fontFamily;
}

export function getTerminalFontWeight(config: ConfigLike): number {
  return config?.terminal.fontWeight ?? CONFIG_DEFAULTS.terminal.fontWeight;
}

export function getWallpaperShader(config: ConfigLike): string | null {
  // A null config means the socket has not delivered defaults yet. Once a
  // config exists, preserve an explicit null to allow wallpaper shaders to be
  // disabled.
  return config ? config.wallpaper_shader : CONFIG_DEFAULTS.wallpaperShader;
}

export function getWallpaperOpacity(config: ConfigLike): number {
  return config?.wallpaper_opacity ?? CONFIG_DEFAULTS.wallpaperOpacity;
}

export function getWallpaperBlur(config: ConfigLike): number {
  return config?.wallpaper_blur ?? CONFIG_DEFAULTS.wallpaperBlur;
}

export function getWallpaperSaturate(config: ConfigLike): number {
  return config?.wallpaper_saturate ?? CONFIG_DEFAULTS.wallpaperSaturate;
}

export function getWallpaperSpeed(config: ConfigLike): number {
  return config?.wallpaper_speed ?? CONFIG_DEFAULTS.wallpaperSpeed;
}

export function getWallpaperSeed(config: ConfigLike): string {
  return config?.wallpaper_seed ?? CONFIG_DEFAULTS.wallpaperSeed;
}

export function getWallpaperFollowsMouse(config: ConfigLike): boolean {
  return config?.wallpaper_shader_follows_mouse_cursor ?? CONFIG_DEFAULTS.wallpaperFollowsMouse;
}

export function getWallpaperFollowsKeyboard(config: ConfigLike): boolean {
  return config?.wallpaper_shader_follows_keyboard_input ?? CONFIG_DEFAULTS.wallpaperFollowsKeyboard;
}

export function getPaneSwitchIntensity(config: ConfigLike): number {
  return config?.pane_switch_intensity ?? CONFIG_DEFAULTS.paneSwitchIntensity;
}

export function getPaneSwitchDuration(config: ConfigLike): number {
  return config?.pane_switch_duration ?? CONFIG_DEFAULTS.paneSwitchDuration;
}

export function getSessionSort(config: ConfigLike): ClientConfig['session_sort'] {
  return config?.session_sort ?? CONFIG_DEFAULTS.sessionSort;
}

export function getWindowSort(config: ConfigLike): ClientConfig['window_sort'] {
  return config?.window_sort ?? CONFIG_DEFAULTS.windowSort;
}

export function getWindowGridCount(config: ConfigLike): number {
  return config?.window_grid_count ?? CONFIG_DEFAULTS.windowGridCount;
}

export function getFontWeightRange(fonts: readonly FontEntry[], family: string): { min: number; max: number } {
  const font = fonts.find((entry) => entry.family === family);
  return {
    min: font?.weight_min ?? DEFAULT_FONT_WEIGHT_MIN,
    max: font?.weight_max ?? DEFAULT_FONT_WEIGHT_MAX,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
