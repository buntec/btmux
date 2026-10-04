import type { ReactNode } from 'react';
import { HStack } from '@astryxdesign/core/Layout';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Text } from '@astryxdesign/core/Text';

export interface Hint {
  keys: string[];
  label: ReactNode;
}

/** Compact key-cap hint for overlay footers. */
export function KeyHint({ keys, label }: Hint) {
  return (
    <HStack gap={1} vAlign="center" className="flex-none">
      {keys.map((key) => (
        <Kbd key={key} keys={key} />
      ))}
      {typeof label === 'string' ? (
        <Text size="sm" color="secondary">
          {label}
        </Text>
      ) : (
        label
      )}
    </HStack>
  );
}
