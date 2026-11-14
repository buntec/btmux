let canvas: CanvasRenderingContext2D | null | undefined;

const byte = (n: number) => n.toString(16).padStart(2, '0');

/** A CSS color as `#rrggbb` plus its alpha byte (empty when opaque), or null. */
export function splitColor(value: string): { rgb: string; alpha: string } | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    let digits = hex[1].toLowerCase();
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
    const alpha = digits.slice(6);
    return { rgb: `#${digits.slice(0, 6)}`, alpha: alpha === 'ff' ? '' : alpha };
  }
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) return null;
  // Named, rgb(), oklch(), …: let the browser resolve it to sRGB.
  canvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvas) return null;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = value;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return { rgb: `#${byte(r)}${byte(g)}${byte(b)}`, alpha: a === 255 ? '' : byte(a) };
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
  const alpha = color && color.alpha !== '00' ? color.alpha : '';
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={color?.rgb ?? '#000000'}
      onChange={(e) => onChange(`${e.target.value}${alpha}`)}
      className="btm-color-swatch"
    />
  );
}
