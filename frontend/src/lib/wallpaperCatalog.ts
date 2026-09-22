import { RADIANT_SHADERS } from '../generated/radiantShaders';

export interface WallpaperCatalogItem {
  id: string;
  label: string;
}

export const WALLPAPER_SHADERS: WallpaperCatalogItem[] = RADIANT_SHADERS.map((shader) => ({
  id: `radiant:${shader.id}`,
  label: `Radiant · ${shader.title}`,
})).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));

export function findRadiantShader(configuredId: string) {
  const id = configuredId.startsWith('radiant:') ? configuredId.slice('radiant:'.length) : null;
  return id ? (RADIANT_SHADERS.find((shader) => shader.id === id) ?? null) : null;
}
