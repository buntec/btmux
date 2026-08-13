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
  float phase = u_time * mix(0.55, 1.45, u_random1.w) + u_random2.z * 2.0 * PI;
  vec3 cell = nearestCell(cells, phase);
  vec3 cellColor = mix(u_color1, u_color2, fract(cell.x + u_random2.w));
  cellColor = mix(cellColor, u_color3, cell.y * mix(0.35, 0.85, u_random2.z));
  float centerGlow = 1.0 - smoothstep(0.0, 0.8, cell.z);
  vec3 color = mix(u_background, cellColor, 0.35 + centerGlow * 0.65);
  fragColor = vec4(color, 1.0);
}
`;

export const WALLPAPER_SHADERS: WallpaperShader[] = [
  { id: 'plasma', label: 'plasma', src: PLASMA_FRAGMENT_SRC },
  { id: 'voronoi', label: 'voronoi', src: VORONOI_FRAGMENT_SRC },
];

export function findWallpaperShader(id: string | null | undefined): WallpaperShader | null {
  if (!id) return null;
  return WALLPAPER_SHADERS.find((shader) => shader.id === id) ?? null;
}
