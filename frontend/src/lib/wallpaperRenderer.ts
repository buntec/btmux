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
  followsMouseCursor: boolean;
  followsKeyboardInput: boolean;
}

type FragmentParams = Parameters<GpuShaderDefinition['fragment']>[0];
type NativeFrameParams = Parameters<Parameters<FragmentParams['onBeforeRender']>[0]>[0];
type FrameParams = Omit<NativeFrameParams, 'pointer'> & {
  pointer: NativeFrameParams['pointer'] & { seen?: boolean };
};

export async function loadWallpaperRenderer(id: string) {
  const load = WALLPAPER_SHADER_LOADERS[id as keyof typeof WALLPAPER_SHADER_LOADERS];
  const shader = findWallpaperShader(id);
  if (!load || !shader) return null;
  const { componentDefinition } = await load();
  const source = componentDefinition as GpuShaderDefinition;
  return (canvas: HTMLCanvasElement, options: WallpaperRuntimeOptions, onUnavailable: () => void) => {
    // The core API has no telemetry collector and gives us direct runtime controls.
    const renderer = shaderRendererGPU();
    let disposed = false;
    let current = options;
    let lastValues: Record<string, unknown> = {};
    let pointer = { x: 0.5, y: 0.5, seen: false };
    const running = () => current.animated && current.speed > 0 && !current.paused && !document.hidden;
    const frame = (params: FrameParams): FrameParams => {
      const seen = pointer.seen && (current.followsMouseCursor || current.followsKeyboardInput);
      return {
        ...params,
        deltaTime: running() ? params.deltaTime * current.speed : 0,
        pointer: source.name === 'Boids' && !seen ? { x: -10, y: -10 } : { ...pointer, seen },
        pointerActive: seen,
      };
    };
    const callbacks = (params: FragmentParams): FragmentParams => ({
      ...params,
      onBeforeRender: (callback) =>
        params.onBeforeRender((params) => {
          if (running()) callback(frame(params));
        }),
    });
    // Route simulation input ourselves so native window listeners can't bypass settings.
    const definition: GpuShaderDefinition = source.usesPointer
      ? {
          ...source,
          usesPointer: false,
          fragment: (params) => source.fragment(callbacks(params)),
          compute: source.compute
            ? (params) => {
                const simulation = source.compute!(callbacks(params));
                if (!simulation) return null;
                let firstFrame = true;
                return {
                  ...simulation,
                  getComputeNodes: (params) => {
                    if (!running() && !firstFrame) return null;
                    firstFrame = false;
                    return simulation.getComputeNodes(frame(params as FrameParams));
                  },
                };
              }
            : undefined,
        }
      : source;
    const position = shader.params.find((param) => ['center', 'position'].includes(param.name));
    renderer.setOnUnavailable(onUnavailable);
    renderer.setOnDeviceLost(onUnavailable);
    renderer.registerNode('root', rootPassthrough.fragment, null, null, {}, rootPassthrough);
    const values = () =>
      wallpaperUniformValues(
        shader,
        current.params,
        current.seed,
        source.usesPointer ? 1 : current.animated ? current.speed : 0,
      );
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
      if ((source.animatedTime || source.usesPointer) && running()) renderer.startAnimation();
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
        if (disposed || current.paused || !renderer.isInitialized() || (!position && !source.usesPointer)) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const value = {
          x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
        };
        if (source.usesPointer) pointer = { ...value, seen: true };
        if (!position) return;
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
