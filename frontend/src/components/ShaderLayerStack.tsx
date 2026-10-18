import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { ShaderLayer } from '../generated/protocol';
import {
  MAX_WALLPAPER_SHADER_LAYERS,
  SHADER_BLEND_MODES,
  WALLPAPER_SHADERS,
  createShaderLayer,
  findWallpaperShader,
  shaderAcceptsInput,
} from '../lib/wallpaperCatalog';
import { ShaderParameterFields } from './ShaderParameterFields';

const SHADER_OPTIONS = [
  { title: 'Generators', match: (kind: string) => kind === 'generator', category: null },
  { title: 'Stylize effects', match: (kind: string) => kind === 'effect', category: 'Stylize' },
  { title: 'Adjustment effects', match: (kind: string) => kind === 'effect', category: 'Adjustments' },
].map(({ title, match, category }) => ({
  type: 'section' as const,
  title,
  options: WALLPAPER_SHADERS.filter((shader) => match(shader.kind) && (!category || shader.category === category)).map(
    (shader) => ({ value: shader.id, label: shader.label }),
  ),
}));

function ShaderLayerCard({
  layer,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  layer: ShaderLayer;
  index: number;
  count: number;
  onChange: (layer: ShaderLayer) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const shader = findWallpaperShader(layer.shader);
  const name = `Layer ${index + 1}`;
  const set = (patch: Partial<ShaderLayer>) => onChange({ ...layer, ...patch });
  return (
    <Card padding={3}>
      <VStack gap={3} role="group" aria-label={`${name}: ${shader?.label ?? layer.shader}`}>
        <HStack gap={2} vAlign="end">
          <VStack gap={1} className="min-w-0 flex-1">
            <Selector
              label={name}
              value={layer.shader}
              options={SHADER_OPTIONS}
              hasSearch
              searchPlaceholder="Search shaders"
              onChange={(shader) => set({ shader, params: {} })}
              presentation="adaptive"
              status={shader ? undefined : { type: 'error', message: `Unknown shader "${layer.shader}".` }}
            />
          </VStack>
          <Switch
            label={`${name} enabled`}
            isLabelHidden
            value={layer.enabled}
            onChange={(enabled) => set({ enabled })}
          />
          <IconButton
            label={`Move ${name.toLowerCase()} up`}
            icon={<ArrowUp />}
            variant="ghost"
            isDisabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            label={`Move ${name.toLowerCase()} down`}
            icon={<ArrowDown />}
            variant="ghost"
            isDisabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton label={`Remove ${name.toLowerCase()}`} icon={<Trash2 />} variant="ghost" onClick={onRemove} />
        </HStack>
        {shader && (
          <Text type="supporting">
            {shader.kind === 'effect' ? 'Effect: ' : 'Generator: '}
            {shader.description}
          </Text>
        )}
        {shader && (
          <Collapsible trigger={<Text weight="medium">{shader.label} settings</Text>} defaultIsOpen={count === 1}>
            <VStack gap={4} paddingBlockStart={3}>
              <Selector
                label="Blend mode"
                value={layer['blend-mode']}
                options={SHADER_BLEND_MODES}
                onChange={(mode) => set({ 'blend-mode': mode as ShaderLayer['blend-mode'] })}
                presentation="adaptive"
              />
              <Slider
                label="Layer opacity"
                value={layer.opacity}
                min={0}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={(value) => value.toFixed(2)}
                onChange={(opacity: number) => set({ opacity })}
              />
              {shaderAcceptsInput(shader) && (
                <Switch
                  label="Interactive"
                  description="Follow the mouse or terminal cursor, as enabled above."
                  value={layer.interactive}
                  onChange={(interactive) => set({ interactive })}
                  labelPosition="start"
                  labelSpacing="spread"
                />
              )}
              <ShaderParameterFields shader={shader} params={layer.params} onChange={(params) => set({ params })} />
            </VStack>
          </Collapsible>
        )}
      </VStack>
    </Card>
  );
}

/** Editor for the wallpaper shader stack, bottom layer first. */
export function ShaderLayerStack({
  layers,
  onChange,
}: {
  layers: ShaderLayer[];
  onChange: (layers: ShaderLayer[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const next = [...layers];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  const full = layers.length >= MAX_WALLPAPER_SHADER_LAYERS;
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Text weight="medium">Shader layers</Text>
        <Text type="supporting">
          Layers draw in list order, each on top of the ones before it. Generators draw new content; effects process
          every layer before them. Requires WebGPU.
        </Text>
      </VStack>
      {layers.map((layer, index) => (
        <ShaderLayerCard
          key={`${index}:${layer.shader}`}
          layer={layer}
          index={index}
          count={layers.length}
          onChange={(layer) => onChange(layers.map((current, i) => (i === index ? layer : current)))}
          onMove={(delta) => move(index, delta)}
          onRemove={() => onChange(layers.filter((_, i) => i !== index))}
        />
      ))}
      <Selector
        label="Add shader layer"
        placeholder="Add a generator or effect"
        value=""
        options={SHADER_OPTIONS}
        hasSearch
        searchPlaceholder="Search shaders"
        onChange={(shader) => onChange([...layers, createShaderLayer(shader)])}
        isDisabled={full}
        disabledMessage={`At most ${MAX_WALLPAPER_SHADER_LAYERS} layers.`}
        presentation="adaptive"
      />
    </VStack>
  );
}
