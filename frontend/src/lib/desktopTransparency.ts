export const desktopTransparency = Boolean(
  (window as Window & { __btmuxDesktopTransparency?: boolean }).__btmuxDesktopTransparency,
);

export function pageBackground(color: string, opacity: number): string {
  const fraction = Math.min(1, Math.max(0, opacity));
  return desktopTransparency ? `color-mix(in srgb, ${color} ${fraction * 100}%, transparent)` : color;
}
