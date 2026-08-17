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
