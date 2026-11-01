import { invokeDesktop } from './desktopApp';

export const desktopTransparency = Boolean(
  (window as Window & { __btmuxDesktopTransparency?: boolean }).__btmuxDesktopTransparency,
);

let generation = 0;

/**
 * Sets the page background. The macOS desktop app paints it on the window
 * instead, so its transparent title bar matches.
 */
export function setPageBackground(color: string, opacity: number): void {
  const current = ++generation;
  if (!desktopTransparency) {
    document.body.style.background = color;
    return;
  }
  const alpha = Math.min(1, Math.max(0, opacity));
  document.body.style.background = `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`;
  const rgb = parseHex(color);
  if (!rgb) return;
  // Older apps lack the command; the page keeps its own background then.
  invokeDesktop('set_background', { color: [...rgb, Math.round(alpha * 255)] })?.then(
    () => {
      if (current === generation) document.body.style.background = 'transparent';
    },
    () => {},
  );
}

function parseHex(color: string): [number, number, number] | null {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const value = parseInt(hex, 16);
  return [value >> 16, (value >> 8) & 0xff, value & 0xff];
}
