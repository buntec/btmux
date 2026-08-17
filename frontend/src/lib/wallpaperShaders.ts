export interface WallpaperShader {
  id: string;
  label: string;
  src: string;
}

const HEADER = `#version 300 es
precision highp float;

out vec4 fragColor;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_background;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
uniform vec4 u_random1;
uniform vec4 u_random2;
uniform vec2 u_pointer;
uniform float u_pointer_active;

#define PI 3.141592653589793
`;

const PLASMA_FRAGMENT_SRC = `${HEADER}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time * mix(0.08, 0.22, u_random1.x);
  float v = sin(p.x * mix(1.6, 3.6, u_random1.y) + p.y * mix(-1.2, 1.2, u_random2.z) + t);
  v += sin((p.x + p.y) * mix(1.4, 3.2, u_random1.z) - t * mix(0.8, 1.8, u_random2.w));
  vec2 drift = vec2(sin(t + u_random2.x * PI), cos(t + u_random2.y * PI));
  if (u_pointer_active > 0.5) {
    drift = (u_pointer - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  }
  v += sin(length(p + drift) * mix(2.8, 6.2, u_random1.w) - t * 1.8);
  v = 0.5 + 0.5 * sin(v);

  vec3 color = mix(u_color1, u_color2, smoothstep(0.12, 0.72, v));
  color = mix(color, u_color3, smoothstep(0.72, 1.0, v) * 0.65);
  color = mix(u_background, color, 0.82);
  color *= 0.72 + 0.28 * uv.y;
  fragColor = vec4(color, 1.0);
}
`;

const VORONOI_FRAGMENT_SRC = `${HEADER}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 nearestCell(vec2 p, float phase) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 nearestPoint = vec2(0.0);
  float nearestDistance = 10.0;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 randomPoint = hash22(cell + offset);
      vec2 featurePoint = 0.5 + 0.5 * sin(phase + randomPoint * 2.0 * PI);
      vec2 delta = offset + featurePoint - local;
      float distanceToPoint = length(delta);
      if (distanceToPoint < nearestDistance) {
        nearestPoint = featurePoint;
        nearestDistance = distanceToPoint;
      }
    }
  }

  return vec3(nearestPoint, nearestDistance);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float scale = mix(3.0, 8.0, u_random1.x);
  vec2 stretch = vec2(mix(0.75, 1.35, u_random1.y), mix(0.75, 1.35, u_random1.z));
  vec2 cells = uv * scale * stretch + (u_random2.xy - 0.5) * 4.0;
  if (u_pointer_active > 0.5) {
    vec2 pointerUv = u_pointer / u_resolution;
    cells += (pointerUv - 0.5) * 1.5;
  }
  float phase = u_time * mix(0.55, 1.45, u_random1.w) + u_random2.z * 2.0 * PI;
  vec3 cell = nearestCell(cells, phase);
  vec3 cellColor = mix(u_color1, u_color2, fract(cell.x + u_random2.w));
  cellColor = mix(cellColor, u_color3, cell.y * mix(0.35, 0.85, u_random2.z));
  float centerGlow = 1.0 - smoothstep(0.0, 0.8, cell.z);
  vec3 color = mix(u_background, cellColor, 0.35 + centerGlow * 0.65);
  fragColor = vec4(color, 1.0);
}
`;

/**
 * Adapted from Radiant's “Moiré Interference” shader.
 * https://github.com/pbakaus/radiant/blob/main/static/moire-interference.html
 * Copyright (c) 2025 Paul Bakaus, MIT licensed.
 */
const RADIANT_MOIRE_FRAGMENT_SRC = `${HEADER}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float rings(vec2 uv, vec2 center, float frequency) {
  return sin(length(uv - center) * frequency);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time * mix(0.25, 0.7, u_random1.x);
  float frequency = mix(42.0, 76.0, u_random1.y) * (1.0 + 0.04 * sin(t * 0.3));

  vec2 c0 = vec2(0.22 * cos(t * 0.31), 0.18 * sin(t * 0.43));
  vec2 c1 = vec2(0.25 * cos(t * 0.23 + 2.1), 0.20 * sin(t * 0.37 + 1.4));
  vec2 c2 = vec2(0.19 * sin(t * 0.41 + 4.2), 0.24 * cos(t * 0.29 + 3.1));
  vec2 c3 = vec2(0.21 * cos(t * 0.19 + 5.7), 0.17 * sin(t * 0.47 + 0.8));
  if (u_pointer_active > 0.5) {
    c3 = (u_pointer - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  }

  float r0 = rings(uv, c0, frequency);
  float r1 = rings(uv, c1, frequency * 1.07);
  float r2 = rings(uv, c2, frequency * 0.93);
  float r3 = rings(uv, c3, frequency * 1.13);
  float intensity = clamp(0.5 + 0.5 * (r0 * r1 * r2 * r3 * 0.7 + (r0 + r1 + r2 + r3) * 0.075), 0.0, 1.0);
  float grain = hash21(gl_FragCoord.xy + u_random2.xy * 1000.0) - 0.5;
  vec3 color = mix(u_background, u_color1, smoothstep(0.05, 0.52, intensity));
  color = mix(color, u_color2, smoothstep(0.48, 0.82, intensity));
  color = mix(color, u_color3, smoothstep(0.78, 1.0, intensity));
  fragColor = vec4(color + grain * 0.025, 1.0);
}
`;

export const NATIVE_WALLPAPER_SHADERS: WallpaperShader[] = [
  { id: 'radiant-moire-interference', label: 'Radiant moiré adaptation', src: RADIANT_MOIRE_FRAGMENT_SRC },
  { id: 'plasma', label: 'plasma', src: PLASMA_FRAGMENT_SRC },
  { id: 'voronoi', label: 'voronoi', src: VORONOI_FRAGMENT_SRC },
];

export function findWallpaperShader(id: string | null | undefined): WallpaperShader | null {
  if (!id) return null;
  const nativeId = id.startsWith('btmux:') ? id.slice('btmux:'.length) : id;
  return NATIVE_WALLPAPER_SHADERS.find((shader) => shader.id === nativeId) ?? null;
}
