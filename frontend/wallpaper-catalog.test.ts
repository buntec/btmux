// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { findWallpaperShader, WALLPAPER_SHADERS } from './src/lib/wallpaperCatalog';

test('lists btmux wallpapers in the catalog', () => {
  const labels = new Map(WALLPAPER_SHADERS.map((shader) => [shader.id, shader.label]));
  expect(labels.get('btmux:hexagonal-truchet')).toBe('btmux · Hexagonal Truchet');
  expect(labels.get('btmux:stave-flow')).toBe('btmux · Stave Flow');
  expect(labels.get('btmux:ridgeline')).toBe('btmux · Ridgeline');
});

test('findWallpaperShader resolves prefixed ids to unprefixed ids and pages', () => {
  const truchet = findWallpaperShader('btmux:hexagonal-truchet');
  expect(truchet?.id).toBe('hexagonal-truchet');
  expect(truchet?.src).toBe('/shaders/hexagonal-truchet.html');
  expect(truchet?.params.length).toBeGreaterThan(0);

  const stave = findWallpaperShader('btmux:stave-flow');
  expect(stave?.src).toBe('/shaders/stave-flow.html');
  expect(stave?.params.map((param) => param.name)).toEqual(['STAVE_WIDTH', 'LINE_WIDTH']);

  const radiant = findWallpaperShader('radiant:aurora-curtain');
  expect(radiant?.id).toBe('aurora-curtain');
  expect(radiant?.src).toBe('/radiant/aurora-curtain.html');
});

test('findWallpaperShader rejects bare and unknown ids', () => {
  expect(findWallpaperShader('aurora-curtain')).toBeNull();
  expect(findWallpaperShader('hexagonal-truchet')).toBeNull();
  expect(findWallpaperShader('btmux:nonexistent')).toBeNull();
  expect(findWallpaperShader('')).toBeNull();
});
