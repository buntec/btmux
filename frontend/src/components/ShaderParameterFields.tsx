import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { ShaderValue } from '../generated/protocol';
import {
  findWallpaperShader,
  parameterValue,
  wallpaperUniformValues,
  type WallpaperParameter,
  type WallpaperShaderParams,
} from '../lib/wallpaperCatalog';

function ParameterText({
  param,
  value,
  onChange,
}: {
  param: WallpaperParameter;
  value: ShaderValue;
  onChange: (value: ShaderValue) => void;
}) {
  const serialized = param.kind === 'json' ? JSON.stringify(value, null, 2) : String(value);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(serialized);
    setError(false);
  }, [serialized]);
  const change = (text: string) => {
    setText(text);
    try {
      const next = param.kind === 'json' ? JSON.parse(text) : text;
      if (param.kind === 'color' && !CSS.supports('color', text)) throw new Error('Invalid color');
      if (JSON.stringify(parameterValue(param, next)) !== JSON.stringify(next)) throw new Error('Invalid value');
      setError(false);
      onChange(next);
    } catch {
      setError(true);
    }
  };
  const props = {
    label: param.label,
    description: param.description,
    value: text,
    onChange: change,
    status: error
      ? {
          type: 'error' as const,
          message: param.kind === 'json' ? 'Enter a valid parameter as JSON.' : 'Enter a valid color.',
        }
      : undefined,
  };
  return param.kind === 'json' ? <TextArea {...props} /> : <TextInput {...props} />;
}

export function ShaderParameterFields({
  shaderId,
  params,
  seed,
  onChange,
}: {
  shaderId: string;
  params: WallpaperShaderParams;
  seed: string;
  onChange: (params: WallpaperShaderParams) => void;
}) {
  const shader = findWallpaperShader(shaderId);
  if (!shader) return null;
  const values = wallpaperUniformValues(shader, params, seed, 1);
  const set = (key: string, value: ShaderValue) =>
    onChange({
      ...params,
      [shader.id]: { ...params[shader.id], [key]: value },
    });
  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Text weight="medium">{shader.label} parameters</Text>
        <Button
          label="Reset shader parameters"
          size="sm"
          variant="ghost"
          onClick={() => {
            const next = { ...params };
            delete next[shader.id];
            onChange(next);
          }}
        >
          Reset parameters
        </Button>
      </HStack>
      {shader.params.map((param) => {
        const value = values[param.name];
        const paramKey = `${shader.id}:${param.key}`;
        const common = { label: param.label, description: param.description };
        if (param.kind === 'number') {
          if (param.min !== undefined && param.max !== undefined)
            return (
              <Slider
                key={paramKey}
                {...common}
                value={value as number}
                min={param.min}
                max={param.max}
                step={param.step ?? 0.01}
                valueDisplay="text"
                onChange={(value: number) => set(param.key, value)}
              />
            );
          return (
            <NumberInput
              key={paramKey}
              {...common}
              value={value as number}
              onChange={(value) => {
                if (value !== null) set(param.key, value);
              }}
            />
          );
        }
        if (param.kind === 'boolean')
          return (
            <Switch key={paramKey} {...common} value={value as boolean} onChange={(value) => set(param.key, value)} />
          );
        if (param.kind === 'select')
          return (
            <Selector
              key={paramKey}
              {...common}
              value={String(value)}
              options={param.options?.map((option) => ({ ...option, value: String(option.value) })) ?? []}
              onChange={(value) => {
                const option = param.options?.find((option) => String(option.value) === value);
                if (option) set(param.key, option.value);
              }}
              presentation="adaptive"
            />
          );
        if (param.kind === 'position') {
          const position = value as { x: number; y: number };
          return (
            <VStack key={paramKey} gap={2}>
              <Text>{param.label}</Text>
              <HStack gap={2}>
                <NumberInput
                  label={`${param.label} X`}
                  value={position.x}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(x) => {
                    if (x !== null) set(param.key, { ...position, x });
                  }}
                />
                <NumberInput
                  label={`${param.label} Y`}
                  value={position.y}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(y) => {
                    if (y !== null) set(param.key, { ...position, y });
                  }}
                />
              </HStack>
            </VStack>
          );
        }
        return <ParameterText key={paramKey} param={param} value={value} onChange={(value) => set(param.key, value)} />;
      })}
    </VStack>
  );
}
