import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { randomizeRadiantColor, randomizeRadiantParams, randomizeWallpaper } from '../lib/wallpaperRandom';
import { findWallpaperShader } from '../lib/wallpaperShaders';
import { findRadiantShader } from '../lib/wallpaperCatalog';
import { WALLPAPER_KEYBOARD_CURSOR_EVENT, type WallpaperKeyboardCursorDetail } from '../lib/wallpaperInteraction';

const VERTEX_SRC = `#version 300 es
void main() {
  vec2 position = vec2(
    (gl_VertexID << 1) & 2,
    gl_VertexID & 2
  );
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

interface WallpaperBudget {
  maxFps: number;
  renderScale: number;
}

// Decorative rendering must leave headroom for latency-sensitive terminal
// work. Start below display refresh/native resolution, then step down when the
// main document sees sustained >50ms frames. Recovery is intentionally slower
// than degradation so quality does not oscillate under marginal GPU load.
const WALLPAPER_BUDGETS: readonly WallpaperBudget[] = [
  { maxFps: 30, renderScale: 0.4 },
  { maxFps: 24, renderScale: 0.3 },
  { maxFps: 15, renderScale: 0.25 },
];
const BUDGET_SAMPLE_MS = 2000;
const SLOW_FRAME_MS = 50;
const SLOW_FRAMES_TO_DEGRADE = 3;
const STABLE_WINDOWS_TO_RECOVER = 5;

function useWallpaperBudget(monitor: boolean): WallpaperBudget {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!monitor) return;

    let rafId = 0;
    let lastFrame = performance.now();
    let windowStartedAt = lastFrame;
    let slowFrames = 0;
    let stableWindows = 0;

    const sample = (now: number) => {
      const frameDuration = now - lastFrame;
      if (frameDuration > SLOW_FRAME_MS) {
        // Weight a severe stall as several missed frames so a single long GPU
        // block (such as WebGL context creation) lowers the budget immediately.
        slowFrames += Math.min(SLOW_FRAMES_TO_DEGRADE, Math.max(1, Math.floor(frameDuration / SLOW_FRAME_MS)));
      }
      lastFrame = now;

      if (now - windowStartedAt >= BUDGET_SAMPLE_MS) {
        if (slowFrames >= SLOW_FRAMES_TO_DEGRADE) {
          setLevel((current) => Math.min(current + 1, WALLPAPER_BUDGETS.length - 1));
          stableWindows = 0;
        } else if (slowFrames === 0) {
          stableWindows += 1;
          if (stableWindows >= STABLE_WINDOWS_TO_RECOVER) {
            setLevel((current) => Math.max(0, current - 1));
            stableWindows = 0;
          }
        } else {
          stableWindows = 0;
        }
        slowFrames = 0;
        windowStartedAt = now;
      }

      rafId = requestAnimationFrame(sample);
    };

    rafId = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(rafId);
  }, [monitor]);

  return WALLPAPER_BUDGETS[level];
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSrc: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error('could not create shader program');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'unknown shader link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

interface ShaderWallpaperProps {
  shaderId: string;
  opacity: number;
  blur: number;
  saturate: number;
  speed: number;
  animated: boolean;
  paused?: boolean;
  seed: string;
  followsMouseCursor: boolean;
  followsKeyboardInput: boolean;
}

function NativeShaderWallpaper({
  shaderId,
  opacity,
  blur,
  saturate,
  speed,
  animated,
  paused = false,
  seed,
  followsMouseCursor,
  followsKeyboardInput,
}: ShaderWallpaperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const budget = useWallpaperBudget(animated && !paused);
  const setRuntimeRef = useRef<
    ((animated: boolean, paused: boolean, maxFps: number, renderScale: number) => void) | null
  >(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const effect = findWallpaperShader(shaderId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !effect) return;

    const handleContextLost = (event: Event) => event.preventDefault();
    const handleContextRestored = () => setContextGeneration((generation) => generation + 1);
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) {
      console.warn('btmux: WebGL2 is unavailable; shader wallpaper disabled');
      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      };
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl, effect.src);
    } catch (error) {
      console.error(`btmux: could not compile wallpaper shader "${shaderId}"`, error);
      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      };
    }

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');
    const background = gl.getUniformLocation(program, 'u_background');
    const color1 = gl.getUniformLocation(program, 'u_color1');
    const color2 = gl.getUniformLocation(program, 'u_color2');
    const color3 = gl.getUniformLocation(program, 'u_color3');
    const random1 = gl.getUniformLocation(program, 'u_random1');
    const random2 = gl.getUniformLocation(program, 'u_random2');
    const pointer = gl.getUniformLocation(program, 'u_pointer');
    const pointerActive = gl.getUniformLocation(program, 'u_pointer_active');
    const randomized = randomizeWallpaper(shaderId, seed);
    const startedAt = performance.now();
    let rafId = 0;
    let disposed = false;
    let animationEnabled = animated;
    let temporarilyPaused = paused;
    let maxFps = budget.maxFps;
    let renderScale = budget.renderScale;
    let lastDrawAt = -Infinity;
    let pointerX = -1;
    let pointerY = -1;
    let pointerIsActive = false;

    const setPointer = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      pointerX = ((clientX - rect.left) / rect.width) * canvas.width;
      pointerY = (1 - (clientY - rect.top) / rect.height) * canvas.height;
      pointerIsActive = true;
      if (!animationEnabled && !temporarilyPaused) draw(performance.now());
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (followsMouseCursor) setPointer(event.clientX, event.clientY);
    };
    const handleKeyboardCursor = (event: Event) => {
      if (!followsKeyboardInput) return;
      const { x, y } = (event as CustomEvent<WallpaperKeyboardCursorDetail>).detail;
      setPointer(x, y);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr * renderScale));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr * renderScale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    const draw = (now: number) => {
      if (disposed) return;
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, ((now - startedAt) / 1000) * speed);
      gl.uniform3fv(background, randomized.background);
      gl.uniform3fv(color1, randomized.colors[0]);
      gl.uniform3fv(color2, randomized.colors[1]);
      gl.uniform3fv(color3, randomized.colors[2]);
      gl.uniform4fv(random1, randomized.values.slice(0, 4));
      gl.uniform4fv(random2, randomized.values.slice(4, 8));
      gl.uniform2f(pointer, pointerX, pointerY);
      gl.uniform1f(pointerActive, pointerIsActive ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const tick = (now: number) => {
      if (now - lastDrawAt >= 1000 / maxFps - 1) {
        draw(now);
        lastDrawAt = now;
      }
      if (animationEnabled && !temporarilyPaused && !document.hidden) rafId = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(rafId);
      if (document.hidden || temporarilyPaused) return;
      if (animationEnabled) {
        rafId = requestAnimationFrame(tick);
      } else {
        draw(performance.now());
      }
    };
    setRuntimeRef.current = (nextAnimated, nextPaused, nextMaxFps, nextRenderScale) => {
      if (
        animationEnabled === nextAnimated &&
        temporarilyPaused === nextPaused &&
        maxFps === nextMaxFps &&
        renderScale === nextRenderScale
      ) {
        return;
      }
      animationEnabled = nextAnimated;
      temporarilyPaused = nextPaused;
      maxFps = nextMaxFps;
      renderScale = nextRenderScale;
      lastDrawAt = -Infinity;
      start();
    };

    const handleVisibility = () => start();
    const handleResize = () => {
      if (!animationEnabled && !temporarilyPaused) draw(performance.now());
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, handleKeyboardCursor);
    start();

    return () => {
      disposed = true;
      setRuntimeRef.current = null;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, handleKeyboardCursor);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      gl.deleteProgram(program);
    };
  }, [effect, shaderId, speed, seed, followsMouseCursor, followsKeyboardInput, contextGeneration]);

  // Pausing for a modal should stop/start the existing render loop, not tear
  // down and recompile the native WebGL program at the exact moment the UI is
  // trying to animate the overlay.
  useLayoutEffect(
    () => setRuntimeRef.current?.(animated, paused, budget.maxFps, budget.renderScale),
    [animated, paused, budget],
  );

  if (!effect) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: blur > 0 ? `${-blur * 2}px` : 0,
        width: blur > 0 ? `calc(100% + ${blur * 4}px)` : '100%',
        height: blur > 0 ? `calc(100% + ${blur * 4}px)` : '100%',
        opacity,
        filter: `blur(${blur}px) saturate(${saturate})`,
        zIndex: -1,
        pointerEvents: 'none',
      }}
    />
  );
}

function RadiantShaderWallpaper({
  shaderId,
  opacity,
  blur,
  saturate,
  speed,
  animated,
  paused = false,
  seed,
  followsMouseCursor,
  followsKeyboardInput,
}: ShaderWallpaperProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const shader = findRadiantShader(shaderId);
  const budget = useWallpaperBudget(animated && !paused);

  // This must beat TerminalPane's passive mount effect during a session
  // transition: WebGL context creation is synchronous and can otherwise queue
  // behind an in-flight wallpaper frame before a normal effect gets to pause it.
  useLayoutEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'btmux-runtime', animated: animated && !paused, speed, maxFps: budget.maxFps },
      '*',
    );
  }, [animated, paused, speed, budget.maxFps]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !shader) return;

    const postRuntime = () =>
      iframe.contentWindow?.postMessage(
        { type: 'btmux-runtime', animated: animated && !paused, speed, maxFps: budget.maxFps },
        '*',
      );
    const postParams = () => {
      for (const param of randomizeRadiantParams(shader.id, seed, shader.params)) {
        iframe.contentWindow?.postMessage({ type: 'param', ...param }, '*');
      }
    };
    const handleLoad = () => {
      postRuntime();
      postParams();
    };
    const postPointer = (clientX: number, clientY: number) => {
      const rect = iframe.getBoundingClientRect();
      iframe.contentWindow?.postMessage(
        {
          type: 'btmux-pointer',
          x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
          active: true,
        },
        '*',
      );
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (followsMouseCursor) postPointer(event.clientX, event.clientY);
    };
    const handleKeyboardCursor = (event: Event) => {
      if (!followsKeyboardInput) return;
      const { x, y } = (event as CustomEvent<WallpaperKeyboardCursorDetail>).detail;
      postPointer(x, y);
    };

    iframe.addEventListener('load', handleLoad);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, handleKeyboardCursor);
    postRuntime();
    if (!followsMouseCursor && !followsKeyboardInput) {
      iframe.contentWindow?.postMessage({ type: 'btmux-pointer', active: false }, '*');
    }
    return () => {
      iframe.removeEventListener('load', handleLoad);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, handleKeyboardCursor);
    };
  }, [shader, speed, animated, paused, seed, followsMouseCursor, followsKeyboardInput, budget.maxFps]);

  if (!shader) return null;
  const randomizedColor = randomizeRadiantColor(shader.id, seed);
  const bleed = blur * 2;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: blur > 0 ? `${-bleed}px` : 0,
        opacity,
        filter: `blur(${blur}px) saturate(${saturate})`,
        isolation: 'isolate',
        zIndex: -1,
        pointerEvents: 'none',
      }}
    >
      <iframe
        ref={iframeRef}
        src={`/radiant/${shader.file}?seed=${encodeURIComponent(seed)}`}
        title={shader.title}
        sandbox="allow-scripts"
        style={{
          position: 'absolute',
          border: 0,
          inset: 0,
          width: `${100 * budget.renderScale}%`,
          height: `${100 * budget.renderScale}%`,
          transform: `scale(${1 / budget.renderScale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: randomizedColor.cssColor,
          mixBlendMode: 'color',
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

export function ShaderWallpaper(props: ShaderWallpaperProps) {
  return findRadiantShader(props.shaderId) ? (
    <RadiantShaderWallpaper {...props} />
  ) : (
    <NativeShaderWallpaper {...props} />
  );
}
