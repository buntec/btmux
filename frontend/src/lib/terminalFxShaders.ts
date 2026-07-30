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
 * Ported from vfx-js's "block glitch transition" example
 * (https://amagi.dev/vfx-js/examples/#block-glitch-transition,
 * packages/examples/works/block-glitch-transition.html, MIT). There it's a
 * scroll-triggered reveal driven by an `enterTime` uniform (elapsed seconds
 * since an IntersectionObserver fired) plus mouse proximity; multi-scale
 * noise picks blocks to displace, with the displacement magnitude decaying
 * from large to none as enterTime grows — chunky/glitchy at first, settling
 * to a clean view. u_time ("seconds since installed") is exactly that
 * enterTime, so it maps directly onto our contract with no extra plumbing;
 * we just install this on the pane we're transitioning away from and let it
 * play once.
 *
 * Adapted, not a literal port:
 *  - Dropped `mouse`/`offset` (proximity-based extra glitching, and DOM
 *    positioning) — no cursor-tracking or per-element offset concept here.
 *  - u_time is compressed (see ENTER_SPEED) so the original's 1.5s settle
 *    plays out over a couple hundred ms — right for a quick pane-transition
 *    flash, not a slow scroll reveal.
 *  - Fixed a channel bug: the original reads `.rrra` at each displaced
 *    UV — i.e. every output channel (R/G/B) comes from the *source's red
 *    channel only*, at three different offsets. That's a deliberate
 *    monochrome-red-ghost look for the demo's photos, but on typical
 *    terminal palettes (heavy cyan/green/white, often low red) it reads as
 *    dim/washed out. This version samples each output channel from the
 *    *matching* source channel instead — real RGB chromatic aberration.
 *
 * `intensity`/`duration` are the resolved `pane-switch-intensity` /
 * `pane-switch-duration` multipliers, baked into the block-displacement
 * magnitude and settle speed respectively (see chromaticFlashSrc above for
 * why this has to be string interpolation rather than a uniform).
 */
function blockGlitchSrc(intensity: number, duration: number): string {
  // Compresses the original's 1.5s settle-time to ~350ms of real time at
  // duration = 1.0; scales linearly with the duration multiplier.
  const enterSpeed = 1.5 / (0.35 * duration);
  const moveScale = 0.07 * intensity;
  return `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  vec4 readTex(vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture(u_scene, uv);
  }

  float rnd(vec3 p) {
    return fract(sin(dot(p, vec3(892., 982., 48.))) * 4928.);
  }

  float noise(vec3 p) {
    vec3 pi = floor(p);
    vec3 pf = fract(p);
    vec2 d = vec2(1, 0);
    float r1 = mix(
      mix(rnd(pi), rnd(pi + d.xyy), pf.x),
      mix(rnd(pi + d.yxy), rnd(pi + d.xxy), pf.x),
      pf.y
    );
    float r2 = mix(
      mix(rnd(pi + d.yyx), rnd(pi + d.xyx), pf.x),
      mix(rnd(pi + d.yxx), rnd(pi + d.xxx), pf.x),
      pf.y
    );
    return mix(r1, r2, pf.z);
  }

  void main() {
    const float enterSpeed = ${enterSpeed.toFixed(6)};

    vec2 uv = v_uv;
    vec2 p = uv * 2.0 - 1.0;
    p.x *= u_resolution.x / u_resolution.y;

    float t = clamp(u_time * enterSpeed, 0.0, 1.5);
    float enter = mix(exp(t * -2.0) * 3.0, 0.0, t / 1.5);
    float level = smoothstep(0.0, 0.2, t);

    vec2 move = vec2(0.0);
    vec2 block = vec2(0.3, 0.7);

    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 off = vec2(sin(fi * 94.0), sin(fi * 42.0)) * 0.5 + fi;
      vec2 p2 = floor((p - off) * block) / block + off;
      float n = noise(vec3(p2 * 3.0, fi * 7.0 + u_time * 0.3));
      if (n > 0.5) {
        float a = floor(n * 30.0 + fi * 9.0) * 0.5 * 3.141593;
        move = vec2(sin(a), cos(a) * 0.1) * enter * ${moveScale.toFixed(6)};
      }
      block = block.yx * 3.5;
    }

    vec4 cr = readTex(uv + move);
    vec4 cg = readTex(uv + move * 1.2);
    vec4 cb = readTex(uv + move * 1.4);
    vec4 c = vec4(cr.r, cg.g, cb.b, (cr.a + cg.a + cb.a) / 3.0);

    fragColor = c * level;
    fragColor.rgb *= 1.0 + length(move) * 3.0;
  }
`;
}

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

/**
 * Parametrized variant of PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC used by
 * the pane-switch effect registry below, where `intensity`/`duration` are the
 * resolved `pane-switch-intensity` / `pane-switch-duration` multipliers
 * (baked into maxSizePx and rampSeconds). The privacy overlay keeps using the
 * fixed const above — its ramp isn't user-configurable.
 */
function pixelateRampOutSrc(intensity: number, duration: number): string {
  const rampSeconds = 0.15 * duration;
  const maxSizePx = 16.0 * intensity;
  return `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  void main() {
    const float rampSeconds = ${rampSeconds.toFixed(6)};
    const float maxSizePx = ${maxSizePx.toFixed(6)};
    float t = clamp(u_time / rampSeconds, 0.0, 1.0);
    t = 1.0 - pow(1.0 - t, 3.0);
    float sizePx = max(1.0, mix(maxSizePx, 1.0, t));

    vec2 cellUv = sizePx / u_resolution;
    vec2 cell = (floor(v_uv / cellUv) + 0.5) * cellUv;
    fragColor = texture(u_scene, clamp(cell, 0.0, 1.0));
  }
`;
}

/**
 * Pane-switch flash: the CHROMATIC_ABERRATION effect above, but with its
 * intensity driven by a short attack/decay envelope on u_time instead of held
 * constant — the RGB split snaps in as the pane gains focus and decays back to
 * a clean image. Everything else (the mirrored edge sampling, the radial
 * `pow(l, power)` falloff that keeps the center sharp and smears the corners)
 * is vfx-js's ChromaticEffect unchanged.
 *
 * `peak` is in vfx-js intensity units but is much *lower* than its 0.3 default
 * (which the steady-state effect above uses) — 0.3 is the value at the
 * *intensity multiplier's* default of 1.0. The split grows with `pow(l,
 * power)` where l is the aspect-corrected distance from the center, so on a
 * wide pane the corners sit at l² ≈ 5 and the shift there is ~15x what the
 * number suggests: at 0.3 the edge text is smeared unreadable. Chosen by
 * rendering the envelope's peak frame over a mock terminal at 0.03 / 0.06 /
 * 0.12 / 0.25 / 0.5 — 0.1 fringes the edges clearly while every line stays
 * legible, which is what you want from something that flashes on every
 * navigation.
 *
 * `intensity`/`duration` are the resolved `pane-switch-intensity` /
 * `pane-switch-duration` multipliers (see config.rs) baked straight into the
 * GLSL constants — ghostty-web's setPostProcessShader takes only a source
 * string, with no custom-uniform mechanism, so this is the only way to make
 * the effect's numbers configurable.
 */
function chromaticFlashSrc(intensity: number, duration: number): string {
  const attackSeconds = 0.06 * duration;
  const decaySeconds = 0.24 * duration;
  const peak = 0.3 * intensity;
  return `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_scene;
  uniform vec2 u_resolution;
  uniform float u_time;

  vec4 mirrorTex(vec2 uv) {
    vec2 uv2 = 1.0 - abs(1.0 - mod(uv, 2.0));
    return texture(u_scene, uv2);
  }

  void main() {
    const float attackSeconds = ${attackSeconds.toFixed(6)};
    const float decaySeconds = ${decaySeconds.toFixed(6)};
    const float peak = ${peak.toFixed(6)};
    const float power = 2.0;

    float env = u_time < attackSeconds
      ? u_time / attackSeconds
      : 1.0 - clamp((u_time - attackSeconds) / decaySeconds, 0.0, 1.0);
    env = env * env * (3.0 - 2.0 * env); // ease both the attack and the decay
    float intensity = peak * env;

    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = v_uv * 2.0 - 1.0;
    p.x *= aspect;

    float l = length(p);
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
}

/**
 * A one-shot effect played on the pane you just navigated to, selectable from
 * the command palette (`shader: choose pane-switch effect`) and persisted as
 * `pane-switch-shader = "<id>"` in config.toml. Its numbers are scaled by
 * `pane-switch-intensity` / `pane-switch-duration` (also config.toml-only —
 * both are continuous multipliers, not a discrete registry, so they don't
 * fit the picker pattern the id itself uses).
 *
 * Each entry plays from u_time = 0 and is expected to have settled to a clean
 * image by `durationMs`, at which point TerminalPane stops pumping frames and
 * hands the post-process slot back to the persistent effect (SHADER_EFFECTS).
 * A shader that never settles would freeze mid-effect on the pane, so
 * durationMs must cover the shader's own timeline — it scales with the
 * duration multiplier right alongside the GLSL constants that drive it, so
 * the two never drift apart.
 */
export interface PaneSwitchEffect {
  id: string;
  label: string;
  /** GLSL, or null for the "(none)" entry — nothing is installed at all. */
  src: string | null;
  durationMs: number;
}

/** id/label only, for the picker — see buildPaneSwitchEffect for the GLSL. */
interface PaneSwitchEffectEntry {
  id: string;
  label: string;
  build: (intensity: number, duration: number) => { src: string | null; durationMs: number };
}

/** Used when `pane_switch_shader` is unset or names an unknown effect. */
export const DEFAULT_PANE_SWITCH_EFFECT_ID = 'chromatic-aberration';

const PANE_SWITCH_EFFECT_ENTRIES: PaneSwitchEffectEntry[] = [
  {
    id: 'none',
    label: '(none)',
    build: () => ({ src: null, durationMs: 0 }),
  },
  {
    id: 'chromatic-aberration',
    label: 'chromatic aberration (RGB split flash)',
    build: (intensity, duration) => ({
      src: chromaticFlashSrc(intensity, duration),
      // attackSeconds + decaySeconds, rounded up.
      durationMs: Math.ceil(320 * duration),
    }),
  },
  {
    id: 'block-glitch',
    label: 'block glitch (displaced blocks)',
    build: (intensity, duration) => ({
      src: blockGlitchSrc(intensity, duration),
      // >= the shader's own ~350ms settle time (see its enterSpeed).
      durationMs: Math.ceil(400 * duration),
    }),
  },
  {
    id: 'pixelate',
    label: 'pixelate (unblock reveal)',
    build: (intensity, duration) => ({
      src: pixelateRampOutSrc(intensity, duration),
      // Matches its rampSeconds.
      durationMs: Math.ceil(150 * duration),
    }),
  },
];

/** id/label rows for the `shader: choose pane-switch effect` picker. */
export const PANE_SWITCH_EFFECTS: { id: string; label: string }[] = PANE_SWITCH_EFFECT_ENTRIES.map(({ id, label }) => ({
  id,
  label,
}));

/**
 * Resolve a configured `pane_switch_shader` id (falling back to the default)
 * and build its GLSL for the given intensity/duration multipliers (1.0 =
 * each effect's own default). Rebuilds the shader source on every call —
 * callers that install it as a WebGL post-process effect on every render
 * should memoize on (id, intensity, duration) to avoid needless recompiles
 * and, since a fresh object compares unequal by reference, spurious re-fires
 * of effects driven by this object's identity.
 */
export function findPaneSwitchEffect(id: string | null | undefined, intensity = 1, duration = 1): PaneSwitchEffect {
  const entry =
    PANE_SWITCH_EFFECT_ENTRIES.find((e) => e.id === id) ??
    PANE_SWITCH_EFFECT_ENTRIES.find((e) => e.id === DEFAULT_PANE_SWITCH_EFFECT_ID)!;
  return { id: entry.id, label: entry.label, ...entry.build(intensity, duration) };
}

/**
 * A steady-state effect selectable from the command palette
 * (`shader: choose effect`) and persisted as `shader = "<id>"` in config.toml.
 * The backend stores the id verbatim — this registry is the only place ids are
 * defined, so an unknown id resolves to `null` (no effect).
 *
 * The transition shaders above (block-glitch, pixelate ramp in/out) are
 * deliberately absent: each plays once from u_time = 0 and then settles, so as
 * a persistent effect they'd render nothing.
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
