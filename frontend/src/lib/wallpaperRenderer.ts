import { createGpuUniformsMap, rootPassthrough, shaderRendererGPU, type GpuShaderDefinition } from 'shaders/core';
import { WALLPAPER_SHADER_LOADERS } from '../generated/wallpaperShaderLoaders';
import { findWallpaperShader, wallpaperUniformValues, type WallpaperShaderParams } from './wallpaperCatalog';

export interface WallpaperRuntimeOptions {
  params: WallpaperShaderParams;
  seed: string;
  speed: number;
  fps: number;
  resolution: number;
  animated: boolean;
  paused: boolean;
}

export async function loadWallpaperRenderer(id: string) {
  const load = WALLPAPER_SHADER_LOADERS[id as keyof typeof WALLPAPER_SHADER_LOADERS];
  const shader = findWallpaperShader(id);
  if (!load || !shader) return null;
  const { componentDefinition } = await load();
  const definition = componentDefinition as GpuShaderDefinition;
  return (canvas: HTMLCanvasElement, options: WallpaperRuntimeOptions, onUnavailable: () => void) => {
    // The core API has no telemetry collector and gives us direct runtime controls.
    const renderer = shaderRendererGPU();
    let disposed = false;
    let current = options;
    let lastValues: Record<string, unknown> = {};
    const position = shader.params.find((param) => ['center', 'position'].includes(param.name));
    renderer.setOnUnavailable(onUnavailable);
    renderer.setOnDeviceLost(onUnavailable);
    renderer.registerNode('root', rootPassthrough.fragment, null, null, {}, rootPassthrough);
    const values = () =>
      wallpaperUniformValues(shader, current.params, current.seed, current.animated ? current.speed : 0);
    lastValues = values();
    renderer.registerNode(
      'wallpaper',
      definition.fragment,
      'root',
      null,
      createGpuUniformsMap(definition, lastValues, 'wallpaper'),
      definition,
    );

    const update = (next: WallpaperRuntimeOptions) => {
      current = next;
      if (disposed || !renderer.isInitialized()) return;
      renderer.setResolutionScale(next.resolution);
      renderer.setFrameRateCap(next.fps);
      for (const [name, value] of Object.entries(values())) {
        if (JSON.stringify(lastValues[name]) === JSON.stringify(value)) continue;
        renderer.updateUniformValue('wallpaper', name, value);
        lastValues[name] = value;
      }
      if (definition.animatedTime && next.animated && next.speed > 0 && !next.paused && !document.hidden)
        renderer.startAnimation();
      else renderer.stopAnimation();
    };
    const resize = () => {
      if (disposed || !renderer.isInitialized()) return;
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width, rect.height);
      renderer.setResolutionScale(current.resolution);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const visibility = () => update(current);
    document.addEventListener('visibilitychange', visibility);
    return {
      async initialize() {
        await renderer.initialize({ canvas, observeElement: false, colorSpace: 'srgb', toneMapping: 'linear' });
        if (!disposed) update(current);
        else renderer.cleanup();
      },
      update,
      pointer(clientX: number, clientY: number) {
        if (disposed || !position || current.paused || !renderer.isInitialized()) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const value = {
          x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
        };
        renderer.updateUniformValue('wallpaper', position.name, value);
        lastValues[position.name] = value;
      },
      dispose() {
        disposed = true;
        observer.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        renderer.cleanup();
      },
    };
  };
}

export type WallpaperRenderer = ReturnType<NonNullable<Awaited<ReturnType<typeof loadWallpaperRenderer>>>>;
