import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { ShaderLayer } from '../generated/protocol';
import { activeShaderLayers, findWallpaperShader } from '../lib/wallpaperCatalog';
import { WALLPAPER_KEYBOARD_CURSOR_EVENT, type WallpaperKeyboardCursorDetail } from '../lib/wallpaperInteraction';
import type { WallpaperRenderer, WallpaperRuntimeOptions } from '../lib/wallpaperRenderer';

interface WallpaperImageProps {
  url: string;
  opacity: number;
  blur: number;
  saturate: number;
}

/** The wallpaper image alone, or while the shader stack can't draw it. */
export function WallpaperImage({ url, opacity, blur, saturate }: WallpaperImageProps) {
  return (
    <div
      aria-hidden="true"
      data-wallpaper-image=""
      className="fixed inset-0 -z-10 pointer-events-none"
      style={{
        backgroundImage: `url(${JSON.stringify(url)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        opacity,
        filter: `blur(${blur}px) saturate(${saturate})`,
      }}
    />
  );
}

interface ShaderWallpaperProps {
  /** Drawn beneath the layers. */
  image: string | null;
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
  // Layers that made the renderer unavailable; changing them retries.
  const failed = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The image the canvas has drawn; until then the DOM image stands in.
  const [drawnImage, setDrawnImage] = useState<string | null>(null);
  const active = activeShaderLayers(props.layers).length > 0;

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
    if (!active) {
      canvas.style.visibility = 'hidden';
      return;
    }
    let disposed = false;
    let instance: WallpaperRenderer | null = null;
    const unavailable = () => {
      if (disposed) return;
      canvas.dataset.shaderState = 'unavailable';
      canvas.style.visibility = 'hidden';
      instance?.dispose();
      rendererRef.current = null;
      setDrawnImage(null);
      failed.current = JSON.stringify(latest.current.layers);
    };
    canvas.dataset.shaderState = 'loading';
    canvas.style.visibility = '';
    void import('../lib/wallpaperRenderer')
      .then(async ({ createWallpaperRenderer }) => {
        if (disposed) return;
        instance = createWallpaperRenderer(canvas, runtime(), unavailable, (url) => {
          if (!disposed) setDrawnImage(url);
        });
        rendererRef.current = instance;
        await instance.initialize();
        if (!disposed && canvas.dataset.shaderState !== 'unavailable') canvas.dataset.shaderState = 'ready';
      })
      .catch(unavailable);
    return () => {
      disposed = true;
      instance?.dispose();
      if (rendererRef.current === instance) rendererRef.current = null;
      setDrawnImage(null);
    };
  }, [attempt, active]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.opacity = String(props.opacity);
    canvas.style.filter = `blur(${props.blur}px) saturate(${props.saturate})`;
    // Bleed the specialized rendering surface so blur doesn't reveal its edges.
    canvas.style.inset = `${-props.blur * 2}px`;
    canvas.style.width = `calc(100vw + ${props.blur * 4}px)`;
    canvas.style.height = `calc(100vh + ${props.blur * 4}px)`;
    if (failed.current !== null && failed.current !== JSON.stringify(props.layers)) {
      failed.current = null;
      setAttempt((attempt) => attempt + 1);
    } else rendererRef.current?.update(runtime());
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

  return (
    <>
      {props.image && drawnImage !== props.image && (
        <WallpaperImage url={props.image} opacity={props.opacity} blur={props.blur} saturate={props.saturate} />
      )}
      <canvas ref={canvasRef} aria-hidden="true" className="fixed -z-10 pointer-events-none" />
    </>
  );
}
