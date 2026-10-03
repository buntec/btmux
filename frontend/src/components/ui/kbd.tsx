import type { ComponentProps } from 'react';
import { Kbd as AstryxKbd } from '@astryxdesign/core/Kbd';
import { HStack } from '@astryxdesign/core/Layout';

export function Kbd({ children, ...props }: ComponentProps<'kbd'>) {
  const value = String(children);
  const names: Record<string, string> = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down' };
  return <AstryxKbd keys={names[value] ?? value} {...props} />;
}

export function KbdGroup({ children, className }: ComponentProps<'div'>) {
  return (
    <HStack as="span" gap={1} className={className}>
      {children}
    </HStack>
  );
}
