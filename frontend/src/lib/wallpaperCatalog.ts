import { WALLPAPER_SHADER_DEFINITIONS } from '../generated/wallpaperShaders';
import type { ClientConfig, ShaderValue } from '../generated/protocol';

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
  params: WallpaperParameter[];
}

export const WALLPAPER_SHADERS = WALLPAPER_SHADER_DEFINITIONS as WallpaperShader[];
export type WallpaperShaderParams = ClientConfig['wallpaper_shader_params'];

export function findWallpaperShader(id: string): WallpaperShader | null {
  return WALLPAPER_SHADERS.find((shader) => shader.id === id) ?? null;
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
  params: WallpaperShaderParams,
  speed: number,
): Record<string, ShaderValue> {
  return Object.fromEntries(
    shader.params.map((param) => {
      let value = parameterValue(param, params[shader.id]?.[param.key]);
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

export function wallpaperParamsToml(params: WallpaperShaderParams): string[] {
  return Object.entries(params).flatMap(([id, values]) => {
    const entries = Object.entries(values).filter(([, value]) => value !== null);
    return entries.length
      ? [
          `[wallpaper-shader-params.${JSON.stringify(id)}]`,
          ...entries.map(([key, value]) => `${JSON.stringify(key)} = ${shaderValueToml(value)}`),
        ]
      : [];
  });
}
