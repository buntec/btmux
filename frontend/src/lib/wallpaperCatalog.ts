import { WALLPAPER_SHADER_DEFINITIONS } from '../generated/wallpaperShaders';
import type { ShaderBlendMode, ShaderLayer, ShaderValue } from '../generated/protocol';

export interface WallpaperParameter {
  name: string;
  key: string;
  label: string;
  description: string;
  kind: string;
  default: ShaderValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  compileTime: boolean;
}

export interface WallpaperShader {
  id: string;
  component: string;
  label: string;
  description: string;
  category: string;
  /** Generators draw new content; effects process every layer beneath them. */
  kind: 'generator' | 'effect';
  usesPointer: boolean;
  params: WallpaperParameter[];
}

export const WALLPAPER_SHADERS = WALLPAPER_SHADER_DEFINITIONS as WallpaperShader[];
export type ShaderParams = ShaderLayer['params'];

/** Mirrors `MAX_WALLPAPER_SHADER_LAYERS` in `src/config.rs`. */
export const MAX_WALLPAPER_SHADER_LAYERS = 8;

export const SHADER_BLEND_MODES: { value: ShaderBlendMode; label: string }[] = (
  [
    'normal',
    'normal-oklch',
    'normal-oklab',
    'multiply',
    'screen',
    'linear-dodge',
    'overlay',
    'difference',
    'color-dodge',
    'exclusion',
    'color',
    'luminosity',
    'darken',
    'lighten',
    'color-burn',
    'linear-burn',
    'soft-light',
    'hard-light',
    'hue',
    'saturation',
  ] as const
).map((value) => ({
  value,
  label:
    { 'normal-oklch': 'Normal (OKLCH)', 'normal-oklab': 'Normal (Oklab)', 'linear-dodge': 'Linear dodge (add)' }[
      value as string
    ] ?? value[0].toUpperCase() + value.slice(1).replace(/-/g, ' '),
}));

export function findWallpaperShader(id: string): WallpaperShader | null {
  return WALLPAPER_SHADERS.find((shader) => shader.id === id) ?? null;
}

/** A new layer with native parameter defaults. */
export function createShaderLayer(shader: string): ShaderLayer {
  return { shader, enabled: true, 'blend-mode': 'normal', opacity: 1, interactive: true, params: {} };
}

/** The parameter that follows the cursor, if any. */
export function positionParameter(shader: WallpaperShader): WallpaperParameter | null {
  return shader.params.find((param) => ['center', 'position', 'lightPosition'].includes(param.name)) ?? null;
}

/** Whether pointer or terminal-cursor input can affect the shader. */
export function shaderAcceptsInput(shader: WallpaperShader): boolean {
  return shader.usesPointer || positionParameter(shader) !== null;
}

/** Enabled layers with known shaders, bottom first. */
export function activeShaderLayers(layers: readonly ShaderLayer[] | null | undefined): ShaderLayer[] {
  return (layers ?? []).filter((layer) => layer.enabled && findWallpaperShader(layer.shader));
}

function validJson(value: ShaderValue): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every(validJson);
  if (value && typeof value === 'object') return Object.values(value).every(validJson);
  return true;
}

export function parameterValue(param: WallpaperParameter, value: ShaderValue | undefined): ShaderValue {
  if (value === undefined || !validJson(value)) return param.default;
  if (param.kind === 'number') {
    if (typeof value !== 'number') return param.default;
    const bounded = Math.max(param.min ?? -Infinity, Math.min(param.max ?? Infinity, value));
    return param.compileTime && Number.isInteger(param.default) && Number.isInteger(param.step)
      ? Math.round(bounded)
      : bounded;
  }
  if (param.kind === 'position') {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      typeof value.x !== 'number' ||
      typeof value.y !== 'number'
    )
      return param.default;
    return { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) };
  }
  if (param.kind === 'select') return param.options?.some((option) => option.value === value) ? value : param.default;
  if (
    param.kind === 'color' &&
    typeof value === 'string' &&
    typeof CSS !== 'undefined' &&
    !CSS.supports('color', value)
  )
    return param.default;
  if (param.kind === 'json') {
    if (param.name === 'stops' && value !== null) {
      if (
        !Array.isArray(value) ||
        !value.every(
          (stop) =>
            stop &&
            !Array.isArray(stop) &&
            typeof stop === 'object' &&
            typeof stop.color === 'string' &&
            typeof stop.position === 'number' &&
            stop.position >= 0 &&
            stop.position <= 1 &&
            (typeof CSS === 'undefined' || CSS.supports('color', stop.color)),
        )
      )
        return param.default;
    }
    return value;
  }
  return typeof value === typeof param.default ? value : param.default;
}

export function wallpaperUniformValues(
  shader: WallpaperShader,
  params: ShaderParams,
  speed: number,
): Record<string, ShaderValue> {
  return Object.fromEntries(
    shader.params.map((param) => {
      let value = parameterValue(param, params[param.key]);
      if (/speed$/i.test(param.name) && typeof value === 'number') value *= speed;
      return [param.name, value];
    }),
  );
}

export function shaderValueToml(value: ShaderValue): string {
  if (value === null) throw new Error('TOML does not support null');
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(shaderValueToml).join(', ')}]`;
  if (typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)} = ${shaderValueToml(entry)}`)
      .join(', ')} }`;
  }
  return String(value);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** `[[wallpaper-shader]]` tables for config.toml, omitting defaults. */
export function wallpaperLayersToml(layers: readonly ShaderLayer[]): string[] {
  return layers.flatMap((layer, index) => {
    const params = Object.entries(layer.params).filter(([, value]) => value !== null);
    return [
      ...(index ? [''] : []),
      '[[wallpaper-shader]]',
      `shader = ${JSON.stringify(layer.shader)}`,
      ...(layer.enabled ? [] : ['enabled = false']),
      ...(layer['blend-mode'] === 'normal' ? [] : [`blend-mode = ${JSON.stringify(layer['blend-mode'])}`]),
      ...(layer.opacity === 1 ? [] : [`opacity = ${Number(layer.opacity.toFixed(4))}`]),
      ...(layer.interactive ? [] : ['interactive = false']),
      ...(params.length
        ? ['[wallpaper-shader.params]', ...params.map(([key, value]) => `${tomlKey(key)} = ${shaderValueToml(value)}`)]
        : []),
    ];
  });
}
