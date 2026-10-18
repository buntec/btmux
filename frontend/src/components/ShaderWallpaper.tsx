import { useEffect, useLayoutEffect, useRef } from 'react';
import { useStore } from '../state/store';
import type { ShaderLayer } from '../generated/protocol';
import { findWallpaperShader } from '../lib/wallpaperCatalog';
import { WALLPAPER_KEYBOARD_CURSOR_EVENT, type WallpaperKeyboardCursorDetail } from '../lib/wallpaperInteraction';
import type { WallpaperRenderer, WallpaperRuntimeOptions } from '../lib/wallpaperRenderer';

interface ShaderWallpaperProps {
  layers: ShaderLayer[];
  opacity: number;
  blur: number;
  saturate: number;
  speed: number;
  fps: number;
  resolution: number;
  animated: boolean;
  paused?: boolean;
  followsMouseCursor: boolean;
  followsKeyboardInput: boolean;
}

export function ShaderWallpaper(props: ShaderWallpaperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WallpaperRenderer | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const showToast = useStore((s) => s.showToast);

  const unknown = props.layers
    .filter((layer) => layer.enabled && !findWallpaperShader(layer.shader))
    .map((layer) => JSON.stringify(layer.shader))
    .join(', ');
  useEffect(() => {
    if (unknown) showToast(`Unknown wallpaper shader ${unknown}`, 'attention');
  }, [unknown, showToast]);
  const runtime = (): WallpaperRuntimeOptions => ({
    ...latest.current,
    paused: !!latest.current.paused || latest.current.opacity === 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let instance: WallpaperRenderer | null = null;
    const unavailable = () => {
      if (disposed) return;
      canvas.dataset.shaderState = 'unavailable';
      canvas.style.visibility = 'hidden';
      instance?.dispose();
      rendererRef.current = null;
    };
    canvas.dataset.shaderState = 'loading';
    canvas.style.visibility = '';
    void import('../lib/wallpaperRenderer')
      .then(async ({ createWallpaperRenderer }) => {
        if (disposed) return;
        instance = createWallpaperRenderer(canvas, runtime(), unavailable);
        rendererRef.current = instance;
        await instance.initialize();
        if (!disposed && canvas.dataset.shaderState !== 'unavailable') canvas.dataset.shaderState = 'ready';
      })
      .catch(unavailable);
    return () => {
      disposed = true;
      instance?.dispose();
      if (rendererRef.current === instance) rendererRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.opacity = String(props.opacity);
    canvas.style.filter = `blur(${props.blur}px) saturate(${props.saturate})`;
    // Bleed the specialized rendering surface so blur doesn't reveal its edges.
    canvas.style.inset = `${-props.blur * 2}px`;
    canvas.style.width = `calc(100vw + ${props.blur * 4}px)`;
    canvas.style.height = `calc(100vh + ${props.blur * 4}px)`;
    rendererRef.current?.update(runtime());
  }, [props]);

  useEffect(() => {
    const mouse = (event: PointerEvent) => {
      if (latest.current.followsMouseCursor) rendererRef.current?.pointer(event.clientX, event.clientY);
    };
    const keyboard = (event: Event) => {
      if (!latest.current.followsKeyboardInput) return;
      const { x, y } = (event as CustomEvent<WallpaperKeyboardCursorDetail>).detail;
      rendererRef.current?.pointer(x, y);
    };
    window.addEventListener('pointermove', mouse, { passive: true });
    window.addEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, keyboard);
    return () => {
      window.removeEventListener('pointermove', mouse);
      window.removeEventListener(WALLPAPER_KEYBOARD_CURSOR_EVENT, keyboard);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="fixed -z-10 pointer-events-none" />;
}
