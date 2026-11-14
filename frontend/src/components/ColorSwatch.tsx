let canvas: CanvasRenderingContext2D | null | undefined;

const byte = (n: number) =>
  Math.round(Math.max(0, Math.min(1, n)) * 255)
    .toString(16)
    .padStart(2, '0');

const SRGB = /^color\(srgb (\S+) (\S+) (\S+)(?: \/ (\S+))?\)$/;

/** A CSS color as `#rrggbb` plus its exact alpha (0–1), or null. */
export function splitColor(value: string): { rgb: string; alpha: number } | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    let digits = hex[1].toLowerCase();
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
    return { rgb: `#${digits.slice(0, 6)}`, alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1 };
  }
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) return null;
  canvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvas) return null;
  // Relative color syntax serializes unpremultiplied sRGB with unquantized alpha.
  canvas.fillStyle = '#000';
  canvas.fillStyle = `color(from ${value} srgb r g b / alpha)`;
  const srgb = SRGB.exec(canvas.fillStyle);
  if (srgb) {
    const [r, g, b, a] = srgb.slice(1).map((n) => (n === undefined ? 1 : Number(n)));
    if ([r, g, b, a].every(Number.isFinite)) return { rgb: `#${byte(r)}${byte(g)}${byte(b)}`, alpha: a };
  }
  // Fallback: canvas readback, alpha quantized to a byte.
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = value;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return { rgb: `#${byte(r / 255)}${byte(g / 255)}${byte(b / 255)}`, alpha: a / 255 };
}

/** `rgb` with `alpha`: hex when a byte holds it exactly, else `rgb()`. Zero alpha becomes opaque. */
export function withAlpha(rgb: string, alpha: number): string {
  if (alpha >= 1 || alpha <= 0) return rgb;
  const quantized = Math.round(alpha * 255);
  if (Math.abs(quantized / 255 - alpha) < 1e-6) return `${rgb}${quantized.toString(16).padStart(2, '0')}`;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16));
  return `rgb(${r} ${g} ${b} / ${Number(alpha.toFixed(6))})`;
}

/**
 * The browser's color picker for a CSS color value. It picks only RGB, so a
 * translucent value keeps its alpha; a fully transparent one becomes opaque.
 */
export function ColorSwatch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const color = splitColor(value);
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={color?.rgb ?? '#000000'}
      onChange={(e) => onChange(withAlpha(e.target.value, color?.alpha ?? 1))}
      className="btm-color-swatch"
    />
  );
}
