import { RADIANT_SHADERS } from '../generated/radiantShaders';
import type { RadiantShaderParam } from './wallpaperRandom';

export interface WallpaperCatalogItem {
  id: string;
  label: string;
}

export interface WallpaperShaderDefinition {
  id: string;
  title: string;
  desc?: string;
  url: string;
  tags?: readonly string[];
  technique?: string;
  params?: readonly RadiantShaderParam[];
}

/** A configured wallpaper resolved to the page the iframe loads. */
export interface WallpaperShader {
  id: string;
  title: string;
  src: string;
  params: readonly RadiantShaderParam[];
}

// Authored in this repo (frontend/public/shaders), apart from the vendored
// Radiant set, which sync-radiant regenerates.
export const BTMUX_WALLPAPER_SHADERS: readonly WallpaperShaderDefinition[] = [
  {
    id: 'hexagonal-truchet',
    title: 'Hexagonal Truchet',
    desc: 'Interlocking geometric paths and flowing energy circuits on a hexagonal lattice.',
    url: '/shaders/hexagonal-truchet.html',
    tags: ['geometric', 'lines', 'truchet', 'hexagonal'],
    technique: 'webgl',
    params: [
      { name: 'SCALE', min: 0.5, max: 4.0, step: 0.1 },
      { name: 'LINE_WIDTH', min: 0.01, max: 0.1, step: 0.01 },
      { name: 'GLOW', min: 0.1, max: 2.0, step: 0.1 },
      { name: 'SPEED', min: 0.2, max: 3.0, step: 0.1 },
    ],
  },
  {
    id: 'stave-flow',
    title: 'Stave Flow',
    desc: 'Stacked pen lines that calm at the edges and break into waves around a drifting center.',
    url: '/shaders/stave-flow.html',
    tags: ['lines', 'waves', 'webgl'],
    technique: 'webgl',
    params: [
      { name: 'STAVE_WIDTH', min: 0.5, max: 3.0, step: 0.1 },
      { name: 'LINE_WIDTH', min: 0.1, max: 1.0, step: 0.1 },
    ],
  },
  {
    id: 'ridgeline',
    title: 'Ridgeline',
    desc: 'Stacked noise-displaced lines with hidden-line occlusion and relief around a drifting center.',
    url: '/shaders/ridgeline.html',
    tags: ['lines', 'noise', 'webgl'],
    technique: 'webgl',
    params: [
      { name: 'LINE_COUNT', min: 40, max: 170, step: 1 },
      { name: 'NOISE_FREQ_X', min: 0.01, max: 0.18, step: 0.005 },
      { name: 'NOISE_FREQ_Y', min: 0.005, max: 0.09, step: 0.005 },
      { name: 'AMPLITUDE', min: 4, max: 60, step: 1 },
      { name: 'CLUSTER_SIDE', min: 0, max: 1, step: 0.01 },
      { name: 'PEN_OPACITY', min: 0.1, max: 1, step: 0.05 },
      { name: 'LINE_WIDTH', min: 0.1, max: 1.0, step: 0.1 },
    ],
  },
];

export const WALLPAPER_SHADERS: WallpaperCatalogItem[] = [
  ...BTMUX_WALLPAPER_SHADERS.map((shader) => ({
    id: `btmux:${shader.id}`,
    label: `btmux · ${shader.title}`,
  })),
  ...RADIANT_SHADERS.map((shader) => ({
    id: `radiant:${shader.id}`,
    label: `Radiant · ${shader.title}`,
  })),
].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));

/** Resolve a prefixed config id; `id` stays unprefixed to keep seeded randomization stable. */
export function findWallpaperShader(configuredId: string): WallpaperShader | null {
  if (configuredId.startsWith('btmux:')) {
    const local = BTMUX_WALLPAPER_SHADERS.find((shader) => `btmux:${shader.id}` === configuredId);
    return local ? { id: local.id, title: local.title, src: local.url, params: local.params ?? [] } : null;
  }
  if (!configuredId.startsWith('radiant:')) return null;
  const id = configuredId.slice('radiant:'.length);
  const radiant = RADIANT_SHADERS.find((shader) => shader.id === id);
  return radiant
    ? { id: radiant.id, title: radiant.title, src: `/radiant/${radiant.file}`, params: radiant.params }
    : null;
}
