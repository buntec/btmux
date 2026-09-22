import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { randomizeRadiantColor, randomizeRadiantParams } from '../lib/wallpaperRandom';
import { findRadiantShader } from '../lib/wallpaperCatalog';
import { WALLPAPER_KEYBOARD_CURSOR_EVENT, type WallpaperKeyboardCursorDetail } from '../lib/wallpaperInteraction';

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
  return findRadiantShader(props.shaderId) ? <RadiantShaderWallpaper {...props} /> : null;
}
