export const desktopVibrancy = Boolean(
  (window as Window & { __btmuxDesktopVibrancy?: boolean }).__btmuxDesktopVibrancy,
);

export function pageBackground(color: string): string {
  return desktopVibrancy ? `color-mix(in srgb, ${color} 82%, transparent)` : color;
}
