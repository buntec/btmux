import type { ReactNode } from 'react';
import { VStack } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { cn } from '@/lib/utils';

/** Centered loading, empty, or error message for a file browser region. */
export function Placeholder({
  children,
  isLoading = false,
  isError = false,
}: {
  children: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
}) {
  return (
    <VStack
      hAlign="center"
      vAlign="center"
      gap={2}
      role={isLoading ? 'status' : undefined}
      className="min-h-0 flex-1 p-4 text-center"
    >
      {isLoading && <Spinner size="sm" aria-label="Loading" />}
      <Text color={isError ? 'inherit' : 'secondary'} className={cn(isError && 'text-error')}>
        {children}
      </Text>
    </VStack>
  );
}
