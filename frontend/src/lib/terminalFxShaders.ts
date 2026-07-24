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

// vfx-js PixelateEffect, size 10px (its default).
export const PIXELATE_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;

  void main() {
    const float sizePx = 10.0;
    vec2 cellUv = sizePx / u_resolution;
    vec2 cell = (floor(v_uv / cellUv) + 0.5) * cellUv;
    fragColor = texture(u_scene, clamp(cell, 0.0, 1.0));
  }
`;

/**
 * Per-pane privacy-pixelate overlay (App.tsx's usePanePixelateOverlay),
 * replacing the old whole-stage SVG CSS filter (pix-filter.ts, removed).
 * Ramps in when installed and holds at full strength — u_time is "seconds
 * since this shader was installed", so once t reaches 1 the shader just
 * keeps rendering the fully-pixelated steady state; no separate hold-state
 * shader needed. Sizes/durations are the same values the SVG filter used
 * (PIX_MAX_BLOCK, PIX_RAMP_IN_MS).
 */
export const PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  void main() {
    const float rampSeconds = 0.25; // PIX_RAMP_IN_MS
    const float maxSizePx = 16.0;
    float t = clamp(u_time / rampSeconds, 0.0, 1.0);
    t = 1.0 - pow(1.0 - t, 3.0); // ease-out cubic, matches the old ramp's easing
    float sizePx = max(1.0, maxSizePx * t);

    vec2 cellUv = sizePx / u_resolution;
    vec2 cell = (floor(v_uv / cellUv) + 0.5) * cellUv;
    fragColor = texture(u_scene, clamp(cell, 0.0, 1.0));
  }
`;

/**
 * Ramp-out counterpart to PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC: shrinks
 * from full strength back to unpixelated over rampSeconds after being
 * installed. The caller (usePanePixelateOverlay) is responsible for calling
 * setPostProcessShader(null) once that duration elapses — this shader alone
 * doesn't remove itself, u_time only ever increases.
 */
export const PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  void main() {
    const float rampSeconds = 0.15; // PIX_RAMP_OUT_MS
    const float maxSizePx = 16.0;
    float t = clamp(u_time / rampSeconds, 0.0, 1.0);
    t = 1.0 - pow(1.0 - t, 3.0);
    float sizePx = max(1.0, mix(maxSizePx, 1.0, t));

    vec2 cellUv = sizePx / u_resolution;
    vec2 cell = (floor(v_uv / cellUv) + 0.5) * cellUv;
    fragColor = texture(u_scene, clamp(cell, 0.0, 1.0));
  }
`;
