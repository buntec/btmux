import { expect, test } from 'bun:test';
import {
  findWallpaperShader,
  parameterValue,
  wallpaperParamsToml,
  wallpaperUniformValues,
  WALLPAPER_SHADERS,
} from './src/lib/wallpaperCatalog';

const aurora = findWallpaperShader('aurora')!;

test('catalog contains native generators and rejects retired wallpaper IDs', () => {
  expect(WALLPAPER_SHADERS.length).toBe(22);
  expect(aurora.component).toBe('Aurora');
  for (const [id, component] of [
    ['chroma-flow', 'ChromaFlow'],
    ['cursor-trail', 'CursorTrail'],
    ['ink-flow', 'InkFlow'],
    ['boids', 'Boids'],
  ]) {
    expect(findWallpaperShader(id)?.component).toBe(component);
  }
  expect(findWallpaperShader('radiant:aurora-curtain')).toBeNull();
  expect(findWallpaperShader('btmux:hexagonal-truchet')).toBeNull();
  expect(findWallpaperShader('missing')).toBeNull();
});

test('native parameter overrides are isolated by generator and use kebab-case', () => {
  const values = wallpaperUniformValues(
    aurora,
    {
      aurora: { 'color-a': '#123456', 'curtain-count': 2, seed: 12, speed: 3 },
      swirl: { speed: 9 },
    },
    'example',
    0.5,
  );
  expect(values.colorA).toBe('#123456');
  expect(values.curtainCount).toBe(2);
  expect(values.seed).toBe(12);
  expect(values.speed).toBe(1.5);
  expect(values.colorB).toBe('#22ee88');
});

test('invalid config values fall back safely and numeric ranges are enforced', () => {
  const values = wallpaperUniformValues(
    aurora,
    {
      aurora: {
        'color-space': 'invalid',
        'curtain-count': 500,
        speed: 'fast',
        center: [1, 2],
        intensity: NaN,
        notAParameter: 123,
      },
    },
    'seed',
    1,
  );
  expect(values.colorSpace).toBe('linear');
  expect(values.curtainCount).toBe(4);
  expect(values.speed).toBe(5);
  expect(values.center).toEqual({ x: 0.5, y: 0 });
  expect(values.intensity).toBe(80);
  expect(values.notAParameter).toBeUndefined();
  const stops = findWallpaperShader('strands')!.params.find((param) => param.name === 'stops')!;
  expect(parameterValue(stops, [false])).toEqual(stops.default);
});

test('seed is deterministic and an explicit native seed takes precedence', () => {
  expect(wallpaperUniformValues(aurora, {}, 'same', 1)).toEqual(wallpaperUniformValues(aurora, {}, 'same', 1));
  expect(wallpaperUniformValues(aurora, { aurora: { seed: 0 } }, 'same', 1).seed).toBe(0);
});

test('Settings TOML preserves strings, vectors, booleans, and color-stop arrays', () => {
  const params = {
    aurora: { 'color-a': '#123456', center: { x: 0.3, y: 0.7 }, speed: 2 },
    strands: {
      'pin-edges': true,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 1 },
      ],
    },
  };
  const toml = wallpaperParamsToml(params).join('\n');
  expect(Bun.TOML.parse(toml)['wallpaper-shader-params']).toEqual(params);
  expect(wallpaperParamsToml({ aurora: { stops: null } })).toEqual([]);
  expect(wallpaperParamsToml({})).toEqual([]);
});
