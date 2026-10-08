import { expect, test } from 'bun:test';
import {
  findWallpaperShader,
  parameterValue,
  wallpaperParamsToml,
  WALLPAPER_SHADERS,
} from './src/lib/wallpaperCatalog';
import { randomizeWallpaperParams } from './src/lib/wallpaperRandomize';

function randomStream(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test('every shader gets a complete native parameter set that round-trips through TOML', () => {
  for (const shader of WALLPAPER_SHADERS) {
    for (const random of [() => 0, () => 0.999999, randomStream(17)]) {
      const params = randomizeWallpaperParams(shader, {}, random);
      expect(Object.keys(params[shader.id])).toEqual(shader.params.map((param) => param.key));
      for (const param of shader.params) {
        const value = params[shader.id][param.key];
        expect(parameterValue(param, value)).toEqual(value);
        if (param.kind === 'number') {
          expect(value).toBeGreaterThanOrEqual(param.min!);
          expect(value).toBeLessThanOrEqual(param.max!);
          const steps = (Number(value) - param.min!) / param.step!;
          expect(steps).toBeCloseTo(Math.round(steps), 7);
        }
        if (param.kind === 'color') expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
        if (param.kind === 'json') {
          expect(param.name).toBe('stops');
          const stops = value as { color: string; position: number }[];
          expect(stops.length).toBeGreaterThanOrEqual(2);
          expect(stops.length).toBeLessThanOrEqual(5);
          expect(stops[0].position).toBe(0);
          expect(stops.at(-1)!.position).toBe(1);
          for (let i = 1; i < stops.length; i++) expect(stops[i].position).toBeGreaterThan(stops[i - 1].position);
        }
      }
      expect(Bun.TOML.parse(wallpaperParamsToml(params).join('\n'))['wallpaper-shader-params']).toEqual(params);
    }
  }
});

test('randomization replaces explicit seeds and settings without changing other shaders or input objects', () => {
  const params = { aurora: { seed: 0, speed: 0, 'color-a': '#123456' }, 'chroma-flow': { radius: 2 } };
  const before = structuredClone(params);
  const randomized = randomizeWallpaperParams(findWallpaperShader('aurora')!, params, () => 0);
  expect(randomized.aurora.seed).not.toBe(0);
  expect(randomized.aurora.speed).not.toBe(0);
  expect(randomized.aurora['color-a']).not.toBe('#123456');
  expect(randomized['chroma-flow']).toBe(params['chroma-flow']);
  expect(params).toEqual(before);
});

test('seedless shaders vary colors and dynamics, and expensive or invisible settings are avoided', () => {
  const chroma = findWallpaperShader('chroma-flow')!;
  const first = randomizeWallpaperParams(chroma, {}, randomStream(1))['chroma-flow'];
  const second = randomizeWallpaperParams(chroma, {}, randomStream(2))['chroma-flow'];
  for (const param of chroma.params) expect(first[param.key]).not.toEqual(second[param.key]);
  for (let attempt = 0; attempt < 50; attempt++) {
    const boids = randomizeWallpaperParams(findWallpaperShader('boids')!, {}, randomStream(attempt));
    expect(boids.boids.count).toBeLessThanOrEqual(2400);
    const strands = randomizeWallpaperParams(findWallpaperShader('strands')!, {}, randomStream(attempt));
    expect(strands.strands['line-width']).toBeGreaterThan(0);
    const gradient = randomizeWallpaperParams(findWallpaperShader('linear-gradient')!, {}, randomStream(attempt));
    const start = gradient['linear-gradient'].start as { x: number; y: number };
    const end = gradient['linear-gradient'].end as { x: number; y: number };
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeGreaterThan(0.7);
  }
});
