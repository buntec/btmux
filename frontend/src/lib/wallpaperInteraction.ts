export const WALLPAPER_KEYBOARD_CURSOR_EVENT = 'btmux:wallpaper-keyboard-cursor';

export interface WallpaperKeyboardCursorDetail {
  x: number;
  y: number;
}

export function announceWallpaperKeyboardCursor(x: number, y: number): void {
  window.dispatchEvent(
    new CustomEvent<WallpaperKeyboardCursorDetail>(WALLPAPER_KEYBOARD_CURSOR_EVENT, {
      detail: { x, y },
    }),
  );
}
