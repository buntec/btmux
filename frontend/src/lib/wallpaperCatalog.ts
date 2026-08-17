import { RADIANT_SHADERS } from '../generated/radiantShaders';
import { NATIVE_WALLPAPER_SHADERS } from './wallpaperShaders';

export interface WallpaperCatalogItem {
  id: string;
  label: string;
  source: 'btmux' | 'radiant';
}

export const WALLPAPER_SHADERS: WallpaperCatalogItem[] = [
  ...RADIANT_SHADERS.map((shader) => ({
    id: `radiant:${shader.id}`,
    label: `Radiant · ${shader.title}`,
    source: 'radiant' as const,
  })),
  ...NATIVE_WALLPAPER_SHADERS.map((shader) => ({
    id: `btmux:${shader.id}`,
    label: `btmux · ${shader.label}`,
    source: 'btmux' as const,
  })),
];

export function findRadiantShader(configuredId: string) {
  const id = configuredId.startsWith('radiant:') ? configuredId.slice('radiant:'.length) : null;
  return id ? (RADIANT_SHADERS.find((shader) => shader.id === id) ?? null) : null;
}
