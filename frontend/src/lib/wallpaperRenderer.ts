import {
  createGpuUniformsMap,
  rootPassthrough,
  shaderRendererGPU,
  type BlendMode,
  type GpuShaderDefinition,
  type NodeMetadata,
} from 'shaders/core';
import type { ShaderBlendMode, ShaderLayer } from '../generated/protocol';
import { WALLPAPER_SHADER_LOADERS } from '../generated/wallpaperShaderLoaders';
import {
  activeShaderLayers,
  findWallpaperShader,
  positionParameter,
  wallpaperUniformValues,
  type WallpaperParameter,
  type WallpaperShader,
} from './wallpaperCatalog';

export interface WallpaperRuntimeOptions {
  layers: ShaderLayer[];
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

const BLEND_MODES: Record<ShaderBlendMode, BlendMode> = {
  normal: 'normal',
  'normal-oklch': 'normal-oklch',
  'normal-oklab': 'normal-oklab',
  multiply: 'multiply',
  screen: 'screen',
  'linear-dodge': 'linearDodge',
  overlay: 'overlay',
  difference: 'difference',
  'color-dodge': 'colorDodge',
  exclusion: 'exclusion',
  color: 'color',
  luminosity: 'luminosity',
  darken: 'darken',
  lighten: 'lighten',
  'color-burn': 'colorBurn',
  'linear-burn': 'linearBurn',
  'soft-light': 'softLight',
  'hard-light': 'hardLight',
  hue: 'hue',
  saturation: 'saturation',
};

// These read the pointer position even while it is inactive.
const IDLE_POINTER_OFFSCREEN = new Set(['Boids', 'PixelSort']);

const definitions = new Map<string, Promise<GpuShaderDefinition>>();

function loadDefinition(id: string): Promise<GpuShaderDefinition> {
  let definition = definitions.get(id);
  if (!definition) {
    const load = WALLPAPER_SHADER_LOADERS[id as keyof typeof WALLPAPER_SHADER_LOADERS];
    definition = load().then(({ componentDefinition }) => componentDefinition as GpuShaderDefinition);
    definitions.set(id, definition);
  }
  return definition;
}

/** Whether the layer changes over time without new input. */
function animates(source: GpuShaderDefinition): boolean {
  return (
    !!source.animatedTime ||
    !!source.extraAnimatedTimes ||
    !!source.usesPointer ||
    'speed' in source.props ||
    'animated' in source.props
  );
}

interface LayerNode {
  id: string;
  shader: WallpaperShader;
  source: GpuShaderDefinition;
  position: WallpaperParameter | null;
  layer: ShaderLayer;
  values: Record<string, unknown>;
  metadata: Pick<NodeMetadata, 'blendMode' | 'opacity' | 'renderOrder'>;
}

/** Renders a stack of shader layers; an effect layer processes every layer beneath it. */
export function createWallpaperRenderer(
  canvas: HTMLCanvasElement,
  options: WallpaperRuntimeOptions,
  onUnavailable: () => void,
) {
  // The core API has no telemetry collector and gives us direct runtime controls.
  const renderer = shaderRendererGPU();
  let disposed = false;
  let current = options;
  let nodes: LayerNode[] = [];
  let serial = 0;
  let resolution = 0;
  let synced = Promise.resolve();
  let pointer = { x: 0.5, y: 0.5, seen: false };
  const running = () => current.animated && current.speed > 0 && !current.paused && !document.hidden;
  const following = () => current.followsMouseCursor || current.followsKeyboardInput;

  const wrap = (node: LayerNode): GpuShaderDefinition => {
    const { source } = node;
    if (!source.usesPointer) return source;
    const frame = (params: FrameParams): FrameParams => {
      const seen = pointer.seen && following() && node.layer.interactive;
      return {
        ...params,
        deltaTime: running() ? params.deltaTime * current.speed : 0,
        // Park unseen input where simulations start, so a new layer gets no impulse.
        pointer: seen
          ? { ...pointer, seen }
          : IDLE_POINTER_OFFSCREEN.has(source.name)
            ? { x: -10, y: -10 }
            : { x: 0.5, y: 0.5, seen },
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
    return {
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
    };
  };
  const uniformValues = (node: Pick<LayerNode, 'shader' | 'source' | 'layer'>) =>
    wallpaperUniformValues(
      node.shader,
      node.layer.params,
      node.source.usesPointer ? 1 : current.animated ? current.speed : 0,
    );
  const metadataOf = (layer: ShaderLayer, renderOrder: number) => ({
    blendMode: BLEND_MODES[layer['blend-mode']] ?? 'normal',
    opacity: layer.opacity,
    renderOrder,
  });

  /** Brings the node list in line with the enabled layers. */
  const reconcile = (layers: ShaderLayer[], sources: GpuShaderDefinition[]) => {
    let changed = false;
    let structural = false;
    const next: LayerNode[] = [];
    layers.forEach((layer, index) => {
      const shader = findWallpaperShader(layer.shader)!;
      const existing = nodes[index];
      if (existing?.shader.id === shader.id) {
        existing.layer = layer;
        const metadata = metadataOf(layer, index);
        if (JSON.stringify(metadata) !== JSON.stringify(existing.metadata)) {
          renderer.updateNodeMetadata(existing.id, metadata);
          existing.metadata = metadata;
          changed = true;
        }
        const tracking = pointer.seen && following() && layer.interactive;
        for (const [name, value] of Object.entries(uniformValues(existing))) {
          // Keep the position the cursor moved to.
          if (tracking && name === existing.position?.name) continue;
          if (JSON.stringify(existing.values[name]) === JSON.stringify(value)) continue;
          renderer.updateUniformValue(existing.id, name, value);
          existing.values[name] = value;
          changed = true;
        }
        next.push(existing);
        return;
      }
      if (existing) renderer.removeNode(existing.id);
      const node: LayerNode = {
        id: `layer-${++serial}`,
        shader,
        source: sources[index],
        position: positionParameter(shader),
        layer,
        values: {},
        metadata: metadataOf(layer, index),
      };
      node.values = uniformValues(node);
      const definition = wrap(node);
      renderer.registerNode(
        node.id,
        definition.fragment,
        'root',
        { ...node.metadata, visible: true },
        createGpuUniformsMap(definition, node.values, node.id),
        definition,
      );
      next.push(node);
      structural = true;
    });
    for (const node of nodes.slice(layers.length)) {
      renderer.removeNode(node.id);
      structural = true;
    }
    nodes = next;
    return { changed: changed || structural, structural };
  };

  const paint = async (waitForGpu = false) => {
    // Core activates a recompiled pipeline after its first frame.
    await renderer.renderSyntheticFrame(0, { waitForGpu: false });
    if (!disposed) await renderer.renderSyntheticFrame(0, { waitForGpu });
  };
  const schedule = (changed: boolean) => {
    if (disposed || !renderer.isInitialized()) return;
    if (nodes.some((node) => animates(node.source)) && running()) renderer.startAnimation();
    else {
      renderer.stopAnimation();
      // Edits still paint when the animation loop is stopped.
      if (changed) void paint().catch(onUnavailable);
    }
  };
  /** Loads the layers' shaders, then reconciles unless a newer update arrived. */
  const sync = () => {
    const options = current;
    const layers = activeShaderLayers(options.layers);
    synced = Promise.all(layers.map((layer) => loadDefinition(layer.shader))).then(async (sources) => {
      if (disposed || options !== current) return;
      let { changed, structural } = reconcile(layers, sources);
      if (renderer.isInitialized()) {
        changed ||= resolution !== options.resolution;
        resolution = options.resolution;
        renderer.setResolutionScale(options.resolution);
        renderer.setFrameRateCap(options.fps);
        // Present the recompiled stack before reporting it.
        if (structural) await paint(true);
        if (disposed || options !== current) return;
        changed &&= !structural;
      }
      canvas.dataset.shaderLayers = nodes.map((node) => node.shader.id).join(' ');
      schedule(changed);
    });
    synced.catch(onUnavailable);
    return synced;
  };

  const update = (next: WallpaperRuntimeOptions) => {
    current = next;
    if (!disposed) void sync();
  };
  const resize = () => {
    if (disposed || !renderer.isInitialized()) return;
    const rect = canvas.getBoundingClientRect();
    renderer.resize(rect.width, rect.height);
    renderer.setResolutionScale(current.resolution);
    void paint().catch(onUnavailable);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const visibility = () => schedule(false);
  document.addEventListener('visibilitychange', visibility);
  renderer.setOnUnavailable(onUnavailable);
  renderer.setOnDeviceLost(onUnavailable);
  renderer.registerNode('root', rootPassthrough.fragment, null, null, {}, rootPassthrough);

  return {
    async initialize() {
      await sync();
      if (disposed) return;
      await renderer.initialize({ canvas, observeElement: false, colorSpace: 'srgb', toneMapping: 'linear' });
      if (disposed) {
        renderer.cleanup();
        return;
      }
      await sync();
      if (!disposed) await paint(true);
    },
    update,
    pointer(clientX: number, clientY: number) {
      if (disposed || current.paused || !renderer.isInitialized()) return;
      const targets = nodes.filter((node) => node.layer.interactive && (node.position || node.source.usesPointer));
      if (!targets.length) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const value = {
        x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
      };
      pointer = { ...value, seen: true };
      for (const node of targets) {
        if (!node.position) continue;
        renderer.updateUniformValue(node.id, node.position.name, value);
        node.values[node.position.name] = value;
      }
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      renderer.cleanup();
    },
  };
}

export type WallpaperRenderer = ReturnType<typeof createWallpaperRenderer>;
