import type { ShaderValue } from '../generated/protocol';
import {
  wallpaperUniformValues,
  type WallpaperParameter,
  type WallpaperShader,
  type WallpaperShaderParams,
} from './wallpaperCatalog';

function colorHex(hue: number, saturation: number, lightness: number): string {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const phase = (offset + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(phase - 3, 9 - phase, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const VISIBLE_NUMBERS = new Set([
  'radius',
  'thickness',
  'lineWidth',
  'density',
  'intensity',
  'amplitude',
  'frequency',
  'speed',
  'force',
]);

export function randomizeWallpaperParams(
  shader: WallpaperShader,
  params: WallpaperShaderParams,
  seed: string,
  random: () => number = Math.random,
): WallpaperShaderParams {
  const sample = (min: number, max: number) => min + random() * (max - min);
  const current = wallpaperUniformValues(shader, params, seed, 1);
  const hue = sample(0, 360);
  const hueSpread = sample(30, 130);
  const saturation = sample(0.55, 0.85);
  const palette = Array.from({ length: 5 }, (_, index) =>
    colorHex(
      (hue + (index * hueSpread) / 4) % 360,
      saturation,
      sample(index % 2 === 0 ? 0.28 : 0.56, index % 2 === 0 ? 0.43 : 0.72),
    ),
  );
  let colorIndex = 0;
  const angle = sample(0, Math.PI * 2);
  const center = { x: sample(0.4, 0.6), y: sample(0.4, 0.6) };
  const endpoint = (direction: number) => ({
    x: center.x + Math.cos(angle) * 0.38 * direction,
    y: center.y + Math.sin(angle) * 0.38 * direction,
  });

  const number = (param: WallpaperParameter): number => {
    const base = param.default as number;
    const step = param.step ?? (Number.isInteger(base) ? 1 : 0.01);
    const min = param.min ?? base - Math.max(1, Math.abs(base));
    const max = param.max ?? base + Math.max(1, Math.abs(base));
    let low = min;
    let high = max;
    if (!['seed', 'angle', 'rotation', 'skewAngle'].includes(param.name)) {
      const spread = Math.max(Math.abs(base) * 0.5, (max - min) * 0.08);
      low = Math.max(min, base - spread);
      high = Math.min(max, base + spread);
      if (min === 0 && VISIBLE_NUMBERS.has(param.name)) low = Math.max(step, low);
      if (shader.id === 'boids' && param.name === 'count') high = Math.min(high, 2400);
    }
    const first = Math.ceil((low - min) / step - 1e-8);
    const last = Math.floor((high - min) / step + 1e-8);
    let index = first + Math.floor(random() * (last - first + 1));
    if (last > first && Math.abs(min + index * step - Number(current[param.name])) < step * 1e-6) {
      index = index === last ? first : index + 1;
    }
    let value = min + index * step;
    if (/speed$/i.test(param.name) && min < 0 && random() < 0.5) value = -value;
    return Number(Math.max(min, Math.min(max, value)).toFixed(8));
  };
  const value = (param: WallpaperParameter): ShaderValue => {
    if (param.kind === 'number') return number(param);
    if (param.kind === 'boolean') return random() < 0.5;
    if (param.kind === 'select') {
      const options = param.options?.filter((option) => option.value !== current[param.name]) ?? [];
      return options[Math.floor(random() * options.length)]?.value ?? param.default;
    }
    if (param.kind === 'color') {
      const color = palette[colorIndex++ % palette.length];
      return param.default === 'transparent'
        ? `${color}${Math.round(sample(0.08, 0.3) * 255)
            .toString(16)
            .padStart(2, '0')}`
        : color;
    }
    if (param.kind === 'position') {
      if (param.name === 'start') return endpoint(-1);
      if (param.name === 'end') return endpoint(1);
      const base = param.default as { x: number; y: number };
      return {
        x: sample(Math.max(0.02, base.x - 0.2), Math.min(0.98, base.x + 0.2)),
        y: sample(Math.max(0.02, base.y - 0.2), Math.min(0.98, base.y + 0.2)),
      };
    }
    if (param.kind === 'json' && param.name === 'stops') {
      const count = 2 + Math.floor(random() * 4);
      return palette.slice(0, count).map((color, index) => ({
        color,
        position:
          index === 0 ? 0 : index === count - 1 ? 1 : Number(((index + sample(-0.15, 0.15)) / (count - 1)).toFixed(4)),
      }));
    }
    return param.default;
  };
  return { ...params, [shader.id]: Object.fromEntries(shader.params.map((param) => [param.key, value(param)])) };
}
