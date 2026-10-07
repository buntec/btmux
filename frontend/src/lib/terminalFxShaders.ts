/**
 * Fragment shaders for ghostty-web's native post-process hook
 * (`term.renderer.setPostProcessShader`, WebGL-only). Unlike the earlier
 * canvasFx.ts spike, this runs as a same-context composite pass inside
 * ghostty-web's own render loop — no cross-context canvas copy, so it
 * doesn't pay the GPU sync cost that made that prototype stall typing.
 *
 * Contract (see ghostty-web's WebGLRenderer.setPostProcessShader):
 *   in vec2 v_uv; uniform sampler2D u_scene; uniform vec2 u_resolution;
 *   uniform float u_time; out vec4 fragColor;
 *
 * VIGNETTE/DITHER/CHROMATIC_ABERRATION/PIXELATE below are ported from
 * fand/vfx-js (https://github.com/fand/vfx-js, MIT License, Copyright (c)
 * fand), packages/effects/src/{vignette,dither,chromatic,pixelate}.ts.
 * Adapted from vfx-js's own contract (`in vec2 uvContent; uniform sampler2D
 * src; uniform vec4 srcRectUv;` — the last supports drawing into a padded
 * sub-rect of a larger buffer) to ours: renamed uniforms, dropped
 * `srcRectUv` (we always render the full scene, so it'd always be the
 * identity `(0,0,1,1)`), and hardcoded each effect's tunable parameters to
 * vfx-js's own defaults (no uniform-passing mechanism exists yet on our
 * side — see setPostProcessShader for how to extend it if that's needed).
 */
export const SCANLINE_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision mediump float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  void main() {
    vec4 color = texture(u_scene, v_uv);

    float scanline = sin(gl_FragCoord.y * 0.8) * 0.5 + 0.5;
    color.rgb *= mix(0.85, 1.0, scanline);

    vec2 centered = v_uv - 0.5;
    float vignette = 1.0 - dot(centered, centered) * 0.6;
    color.rgb *= vignette;

    float flicker = 0.98 + 0.02 * sin(u_time * 8.0);
    color.rgb *= flicker;

    // Preserve the scene's own alpha (don't force opaque): the terminal
    // canvas relies on transparency for cells with no explicit background,
    // letting CSS behind it show through.
    fragColor = vec4(color.rgb, color.a);
  }
`;

// vfx-js VignetteEffect defaults: intensity 0.5, radius 1.0, power 2.0.
export const VIGNETTE_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;

  void main() {
    float aspect = u_resolution.x / u_resolution.y;
    const float intensity = 0.5;
    const float radius = 1.0;
    const float power = 2.0;

    vec4 color = texture(u_scene, v_uv);

    vec2 p = v_uv * 2.0 - 1.0;
    p.x *= aspect;

    float l = max(length(p) - radius, 0.0);
    fragColor = color * (1.0 - pow(l, power) * intensity);
  }
`;

// vfx-js DitherEffect, style "bayer16" (its default), size 2px, levels 3.
export const DITHER_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;

  float bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
  float bayer16(vec2 a) { return bayer8(0.5 * a) * 0.25 + bayer2(a); }

  void main() {
    const float cellSize = 2.0;
    const float levels = 3.0;

    vec2 originPx = floor(gl_FragCoord.xy - v_uv * u_resolution + 0.5);
    vec2 centerPx = gl_FragCoord.xy - originPx - 0.5 * u_resolution;
    vec2 cell = floor(centerPx / cellSize);
    vec2 cellUv = ((cell + 0.5) * cellSize) / u_resolution + 0.5;
    vec4 tex = texture(u_scene, cellUv);

    float th = bayer16(cell);
    float steps = levels - 1.0;
    vec3 q = clamp(floor(tex.rgb * steps + th) / steps, 0.0, 1.0);
    fragColor = vec4(q, tex.a);
  }
`;

// vfx-js ChromaticEffect defaults: intensity 0.3, radius 0.0, power 2.0.
export const CHROMATIC_ABERRATION_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;

  vec4 mirrorTex(vec2 uv) {
    vec2 uv2 = 1.0 - abs(1.0 - mod(uv, 2.0));
    return texture(u_scene, uv2);
  }

  void main() {
    float aspect = u_resolution.x / u_resolution.y;
    const float intensity = 0.3;
    const float radius = 0.0;
    const float power = 2.0;

    vec2 p = v_uv * 2.0 - 1.0;
    p.x *= aspect;

    float l = max(length(p) - radius, 0.0);
    float d = pow(l, power) * (intensity * 0.1);

    vec2 uvR = (v_uv - 0.5) / (1.0 + d * 1.0) + 0.5;
    vec2 uvG = (v_uv - 0.5) / (1.0 + d * 2.0) + 0.5;
    vec2 uvB = (v_uv - 0.5) / (1.0 + d * 3.0) + 0.5;

    vec4 cr = mirrorTex(uvR);
    vec4 cg = mirrorTex(uvG);
    vec4 cb = mirrorTex(uvB);

    fragColor = vec4(cr.r, cg.g, cb.b, (cr.a + cg.a + cb.a) / 3.0);
  }
`;

/**
 * GLSL for `blockAverage(sizePx)`: the mean color of the sizePx-wide block
 * containing v_uv, from an n×n grid of taps (n = block size, at most 8).
 * Needs v_uv, u_scene and u_resolution. Sampling one point per block instead
 * would show whatever single pixel it lands on, mostly background.
 */
const BLOCK_AVERAGE_GLSL = `
  vec4 blockAverage(float sizePx) {
    vec2 cellUv = sizePx / u_resolution;
    vec2 origin = floor(v_uv / cellUv) * cellUv;
    int n = int(clamp(ceil(sizePx), 1.0, 8.0));
    vec4 sum = vec4(0.0);
    for (int y = 0; y < n; y++) {
      for (int x = 0; x < n; x++) {
        vec2 tap = (vec2(float(x), float(y)) + 0.5) / float(n);
        sum += texture(u_scene, clamp(origin + tap * cellUv, 0.0, 1.0));
      }
    }
    return sum / float(n * n);
  }
`;

// vfx-js PixelateEffect, size 10px (its default), block-averaged.
export const PIXELATE_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
${BLOCK_AVERAGE_GLSL}
  void main() {
    const float sizePx = 10.0;
    fragColor = blockAverage(sizePx);
  }
`;

// vfx-js GlitchEffect defaults: speed 1, intensity 1. CRT-style chromatic
// glitch: periodic scanline-band RGB shift/aberration driven by u_time.
// Note its own alpha behavior, kept as-is: fragColor.a is derived from
// output brightness (smoothstep of max channel), not the scene's source
// alpha — dim/background areas fade toward transparent (letting CSS behind
// the canvas show through) while bright glitch content stays opaque. This
// is a deliberate part of the look, not a bug we introduced (unlike the
// earlier accidental "force alpha=1" mistake in an early scanline draft).
export const GLITCH_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform float u_time;

  // Transparent outside the frame — used for jitter/shift reads, which can
  // sample slightly past the edge.
  vec4 readTex(vec2 c) {
    if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return vec4(0.0);
    return texture(u_scene, c);
  }

  float nn(float y, float t) {
    float n = (
      sin(y * .07 + t * 8. + sin(y * .5 + t * 10.)) +
      sin(y * .7 + t * 2. + sin(y * .3 + t * 8.)) * .7 +
      sin(y * 1.1 + t * 2.8) * .4
    );
    n += sin(y * 124. + t * 100.7) * sin(y * 877. - t * 38.8) * .3;
    return n;
  }

  void main() {
    // Toned down from vfx-js's default (1.0) — at full strength this reads
    // as a heavy CRT-glitch effect; for a quick pane-navigation flash a
    // softer touch reads better.
    const float intensity = 0.35;
    vec2 uv = v_uv;
    vec4 color = readTex(uv);

    float t = mod(u_time, 3.14 * 10.);
    float v = fract(sin(t * 2.) * 700.);

    if (abs(nn(uv.y, t)) < 1.2) {
      v *= 0.01;
    }

    vec2 focus = vec2(0.5);
    float d = v * 0.6 * intensity;
    vec2 ruv = focus + (uv - focus) * (1. - d);
    vec2 guv = focus + (uv - focus) * (1. - 2. * d);
    vec2 buv = focus + (uv - focus) * (1. - 3. * d);

    if (v > 0.1) {
      float y = floor(uv.y * 13. * sin(35. * t)) + 1.;
      if (sin(36. * y * v) > 0.9) {
        ruv.x = uv.x + sin(76. * y) * 0.1 * intensity;
        guv.x = uv.x + sin(34. * y) * 0.1 * intensity;
        buv.x = uv.x + sin(59. * y) * 0.1 * intensity;
      }

      v = pow(v * 1.5, 2.) * 0.15 * intensity;
      color.rgb *= 0.3;
      color.r += readTex(vec2(uv.x + sin(t * 123.45) * v, uv.y)).r;
      color.g += readTex(vec2(uv.x + sin(t * 157.67) * v, uv.y)).g;
      color.b += readTex(vec2(uv.x + sin(t * 143.67) * v, uv.y)).b;
    }

    // Unbounded (no edge-transparency check) — matches vfx-js's original,
    // which uses plain texture() here rather than readTex.
    if (abs(nn(uv.y, t)) > 1.1) {
      color.r = color.r * 0.5 + color.r * texture(u_scene, ruv).r;
      color.g = color.g * 0.5 + color.g * texture(u_scene, guv).g;
      color.b = color.b * 0.5 + color.b * texture(u_scene, buv).b;
      color *= 2.;
    }

    fragColor = color;
    fragColor.a = smoothstep(0.0, 0.8, max(color.r, max(color.g, color.b)));
  }
`;

/**
 * A steady-state effect selectable from the command palette
 * (`shader: choose effect`) and persisted as `shader = "<id>"` in config.toml.
 * The backend stores the id verbatim — this registry is the only place ids are
 * defined, so an unknown id resolves to `null` (no effect).
 */
export interface ShaderEffect {
  id: string;
  label: string;
  src: string;
  /**
   * Whether the shader is u_time-driven and therefore needs a continuous
   * render pump (see pumpRenders) to animate on an idle terminal.
   */
  animated: boolean;
}

export const SHADER_EFFECTS: ShaderEffect[] = [
  { id: 'scanline', label: 'scanline (CRT lines + flicker)', src: SCANLINE_POSTPROCESS_FRAGMENT_SRC, animated: true },
  { id: 'vignette', label: 'vignette (darkened edges)', src: VIGNETTE_POSTPROCESS_FRAGMENT_SRC, animated: false },
  { id: 'dither', label: 'dither (bayer16, 3 levels)', src: DITHER_POSTPROCESS_FRAGMENT_SRC, animated: false },
  {
    id: 'chromatic-aberration',
    label: 'chromatic aberration (RGB split)',
    src: CHROMATIC_ABERRATION_POSTPROCESS_FRAGMENT_SRC,
    animated: false,
  },
  { id: 'pixelate', label: 'pixelate (10px blocks)', src: PIXELATE_POSTPROCESS_FRAGMENT_SRC, animated: false },
  { id: 'glitch', label: 'glitch (animated CRT glitch)', src: GLITCH_POSTPROCESS_FRAGMENT_SRC, animated: true },
];

/** Resolve a configured `shader` id to its effect, or null when unset/unknown. */
export function findShaderEffect(id: string | null | undefined): ShaderEffect | null {
  if (!id) return null;
  return SHADER_EFFECTS.find((e) => e.id === id) ?? null;
}
