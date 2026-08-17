export interface WallpaperRandomization {
  background: [number, number, number];
  colors: [[number, number, number], [number, number, number], [number, number, number]];
  values: [number, number, number, number, number, number, number, number];
}

export interface RadiantShaderParam {
  readonly name: string;
  readonly min?: number;
  readonly max: number;
  readonly step?: number;
}

export interface RadiantColorRandomization {
  readonly color: [number, number, number];
  readonly cssColor: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 1) + 1) % 1;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = h * 6;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return [r + match, g + match, b + match];
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  return [
    linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ];
}

function isInSrgbGamut(color: [number, number, number]): boolean {
  return color.every((component) => component >= 0 && component <= 1);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Reduce chroma until an OKLCH color fits the sRGB gamut. */
function gamutMapOklch(lightness: number, chroma: number, hue: number): [number, number, number] {
  const direct = oklchToSrgb(lightness, chroma, hue);
  if (isInSrgbGamut(direct)) return direct;

  let low = 0;
  let high = chroma;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) / 2;
    if (isInSrgbGamut(oklchToSrgb(lightness, middle, hue))) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const mapped = oklchToSrgb(lightness, low, hue);
  return [clampUnit(mapped[0]), clampUnit(mapped[1]), clampUnit(mapped[2])];
}

/**
 * Uses only specified 32-bit integer operations, so a seed maps to the same
 * palette and parameter values in every JavaScript implementation.
 */
export function randomizeWallpaper(shaderId: string, seed: string): WallpaperRandomization {
  const random = mulberry32(fnv1a(`${shaderId}\0${seed}`));
  const hue = random();
  const spread = 0.14 + random() * 0.28;
  const saturation = 0.58 + random() * 0.32;
  const background = hslToRgb(hue + random() * 0.08, 0.35 + random() * 0.3, 0.018 + random() * 0.045);
  const colors: WallpaperRandomization['colors'] = [
    hslToRgb(hue, saturation, 0.46 + random() * 0.18),
    hslToRgb(hue + spread, saturation, 0.44 + random() * 0.2),
    hslToRgb(hue - spread * 0.75, saturation, 0.48 + random() * 0.17),
  ];
  const values = Array.from({ length: 8 }, () => random()) as WallpaperRandomization['values'];
  return { background, colors, values };
}

/**
 * Pick a stable value from every position exposed by a Radiant parameter's
 * range slider. Radiant has a handful of parameters without an explicit min;
 * browsers give those range inputs a minimum of zero, so we do the same.
 *
 * Each parameter gets its own random stream. Adding or reordering catalog
 * parameters therefore does not change the values of existing parameters.
 */
export function randomizeRadiantParams(
  shaderId: string,
  seed: string,
  params: readonly RadiantShaderParam[],
): ReadonlyArray<{ name: string; value: number }> {
  return params.map((param) => {
    const min = param.min ?? 0;
    const step = param.step ?? 0.01;
    const stepCount = Math.max(0, Math.floor((param.max - min) / step + 1e-9));
    const random = mulberry32(fnv1a(`${shaderId}\0${seed}\0${param.name}`));
    const stepIndex = Math.floor(random() * (stepCount + 1));
    const value = Math.min(param.max, min + stepIndex * step);

    return { name: param.name, value };
  });
}

/**
 * Pick a stable, perceptually balanced color in OKLCH. The hue is uniform,
 * while lightness and chroma stay in a range that works well for wallpapers.
 * Keep this on its own stream so adding or reordering numeric parameters does
 * not change it.
 */
export function randomizeRadiantColor(shaderId: string, seed: string): RadiantColorRandomization {
  const random = mulberry32(fnv1a(`${shaderId}\0${seed}\0color`));
  const hue = random() * Math.PI * 2;
  const lightness = 0.55 + random() * 0.2;
  const chroma = 0.08 + random() * 0.1;
  const color = gamutMapOklch(lightness, chroma, hue);
  const cssColor = `rgb(${color.map((component) => `${component * 100}%`).join(' ')})`;

  return { color, cssColor };
}
