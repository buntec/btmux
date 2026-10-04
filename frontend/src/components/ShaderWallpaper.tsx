import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { randomizeRadiantColor, randomizeRadiantParams } from '../lib/wallpaperRandom';
import { findWallpaperShader } from '../lib/wallpaperCatalog';
import { WALLPAPER_KEYBOARD_CURSOR_EVENT, type WallpaperKeyboardCursorDetail } from '../lib/wallpaperInteraction';

const RESOLUTION_RELOAD_DELAY_MS = 300;

interface ShaderWallpaperProps {
  shaderId: string;
  opacity: number;
  blur: number;
  saturate: number;
  speed: number;
  /** Frame-rate cap. */
  fps: number;
  /** Render scale relative to native resolution. */
  resolution: number;
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
  fps,
  resolution,
  animated,
  paused = false,
  seed,
  followsMouseCursor,
  followsKeyboardInput,
}: ShaderWallpaperProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const shader = findWallpaperShader(shaderId);
  // Shaders read devicePixelRatio at startup, so resolution changes reload the
  // iframe. Debounce so dragging the settings slider doesn't reload per tick.
  const [loadedResolution, setLoadedResolution] = useState(resolution);
  useEffect(() => {
    const timer = setTimeout(() => setLoadedResolution(resolution), RESOLUTION_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [resolution]);

  useLayoutEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'btmux-runtime', animated: animated && !paused, speed, maxFps: fps },
      '*',
    );
  }, [animated, paused, speed, fps]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !shader) return;

    const postRuntime = () =>
      iframe.contentWindow?.postMessage(
        { type: 'btmux-runtime', animated: animated && !paused, speed, maxFps: fps },
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
  }, [shader, speed, animated, paused, seed, followsMouseCursor, followsKeyboardInput, fps]);

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
        src={`${shader.src}?seed=${encodeURIComponent(seed)}&resolution=${loadedResolution}`}
        title={shader.title}
        sandbox="allow-scripts"
        style={{
          position: 'absolute',
          border: 0,
          inset: 0,
          width: '100%',
          height: '100%',
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
  return findWallpaperShader(props.shaderId) ? <RadiantShaderWallpaper {...props} /> : null;
}
