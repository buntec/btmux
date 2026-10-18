import { expect, test } from 'bun:test';
import {
  activeShaderLayers,
  createShaderLayer,
  findWallpaperShader,
  parameterValue,
  SHADER_BLEND_MODES,
  shaderAcceptsInput,
  wallpaperLayersToml,
  wallpaperUniformValues,
  WALLPAPER_SHADERS,
} from './src/lib/wallpaperCatalog';
import { WALLPAPER_SHADER_LOADERS } from './src/generated/wallpaperShaderLoaders';

const aurora = findWallpaperShader('aurora')!;

test('catalog contains native generators and effects and rejects unknown IDs', () => {
  expect(WALLPAPER_SHADERS.filter((shader) => shader.kind === 'generator').length).toBe(29);
  expect(WALLPAPER_SHADERS.filter((shader) => shader.kind === 'effect').length).toBe(80);
  // Every effect appears in one of the layer picker's sections.
  expect(
    WALLPAPER_SHADERS.filter(
      (shader) =>
        shader.kind === 'effect' && !['Stylize', 'Adjustments', 'Distortions', 'Blurs', 'Interactive'].includes(shader.category),
    ),
  ).toEqual([]);
  expect(Object.keys(WALLPAPER_SHADER_LOADERS).sort()).toEqual(WALLPAPER_SHADERS.map((shader) => shader.id).sort());
  expect(aurora.component).toBe('Aurora');
  expect(aurora.kind).toBe('generator');
  for (const [id, component] of [
    ['chroma-flow', 'ChromaFlow'],
    ['cursor-trail', 'CursorTrail'],
    ['ink-flow', 'InkFlow'],
    ['boids', 'Boids'],
    ['reaction-diffusion', 'ReactionDiffusion'],
    ['film-grain', 'FilmGrain'],
    ['crt-screen', 'CRTScreen'],
    ['vhs', 'VHS'],
    ['hue-shift', 'HueShift'],
    ['form-3d', 'Form3D'],
    ['cursor-ripples', 'CursorRipples'],
    ['tilt-shift', 'TiltShift'],
  ]) {
    expect(findWallpaperShader(id)?.component).toBe(component);
  }
  expect(findWallpaperShader('crt-screen')!.label).toBe('CRT Screen');
  expect(findWallpaperShader('film-grain')!.kind).toBe('effect');
  expect(findWallpaperShader('lens-flare')!.kind).toBe('generator');
  expect(findWallpaperShader('missing')).toBeNull();
});

test('pointer input reaches interactive shaders and cursor-following positions', () => {
  expect(shaderAcceptsInput(findWallpaperShader('ink-flow')!)).toBe(true);
  expect(shaderAcceptsInput(aurora)).toBe(true);
  expect(shaderAcceptsInput(findWallpaperShader('liquify')!)).toBe(true);
  expect(shaderAcceptsInput(findWallpaperShader('film-grain')!)).toBe(false);
});

test('only enabled layers with known shaders are active', () => {
  const layers = [
    createShaderLayer('aurora'),
    { ...createShaderLayer('film-grain'), enabled: false },
    createShaderLayer('missing'),
    createShaderLayer('vignette'),
  ];
  expect(activeShaderLayers(layers).map((layer) => layer.shader)).toEqual(['aurora', 'vignette']);
  expect(activeShaderLayers(null)).toEqual([]);
});

test('blend modes cover the wire enum with readable labels', () => {
  expect(SHADER_BLEND_MODES.length).toBe(20);
  expect(SHADER_BLEND_MODES.find((mode) => mode.value === 'linear-dodge')!.label).toBe('Linear dodge (add)');
  expect(SHADER_BLEND_MODES.find((mode) => mode.value === 'normal-oklch')!.label).toBe('Normal (OKLCH)');
});

test('native parameter overrides use kebab-case', () => {
  const values = wallpaperUniformValues(aurora, { 'color-a': '#123456', 'curtain-count': 2, seed: 12, speed: 3 }, 0.5);
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
      'color-space': 'invalid',
      'curtain-count': 500,
      speed: 'fast',
      center: [1, 2],
      intensity: NaN,
      notAParameter: 123,
    },
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

test('native seeds use generator defaults unless explicitly overridden', () => {
  for (const shader of WALLPAPER_SHADERS) {
    const seed = shader.params.find((param) => param.name === 'seed');
    if (!seed) continue;
    expect(wallpaperUniformValues(shader, {}, 1).seed).toBe(seed.default);
    expect(wallpaperUniformValues(shader, { seed: 0 }, 1).seed).toBe(0);
  }
});

test('Settings TOML preserves layer order, settings, and every parameter type', () => {
  const layers = [
    { ...createShaderLayer('aurora'), params: { 'color-a': '#123456', center: { x: 0.3, y: 0.7 }, speed: 2 } },
    {
      ...createShaderLayer('strands'),
      enabled: false,
      params: {
        'pin-edges': true,
        stops: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 1 },
        ],
      },
    },
    { ...createShaderLayer('film-grain'), 'blend-mode': 'soft-light' as const, opacity: 0.35, interactive: false },
  ];
  const toml = [...wallpaperLayersToml(layers), '', '[keys]', 'split-vertical = "v"'].join('\n');
  const parsed = Bun.TOML.parse(toml) as Record<string, any>;
  expect(parsed['wallpaper-shader']).toEqual([
    { shader: 'aurora', params: layers[0].params },
    { shader: 'strands', enabled: false, params: layers[1].params },
    { shader: 'film-grain', 'blend-mode': 'soft-light', opacity: 0.35, interactive: false },
  ]);
  expect(parsed.keys).toEqual({ 'split-vertical': 'v' });
  expect(wallpaperLayersToml([{ ...createShaderLayer('aurora'), params: { stops: null } }])).toEqual([
    '[[wallpaper-shader]]',
    'shader = "aurora"',
  ]);
  expect(wallpaperLayersToml([])).toEqual([]);
});
