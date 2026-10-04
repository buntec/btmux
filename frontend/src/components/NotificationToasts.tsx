import { useEffect } from 'react';
import { useToast } from '@astryxdesign/core/Toast';
import { Button } from '@astryxdesign/core/Button';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { subscribeNotifications } from '../lib/notifications';
import { useStore } from '../state/store';

export function NotificationToasts() {
  const toast = useToast();
  useEffect(
    () =>
      subscribeNotifications(({ message, level, body, paneId }) => {
        toast({
          type: level === 'error' ? 'error' : 'info',
          body: (
            <VStack gap={1}>
              <HStack gap={2}>
                <StatusDot
                  label={level}
                  variant={level === 'attention' ? 'warning' : level === 'info' ? 'accent' : level}
                />
                <Text>{message}</Text>
              </HStack>
              {body && <Text>{body}</Text>}
            </VStack>
          ),
          endContent: paneId ? (
            <Button label="View pane" variant="ghost" onClick={() => useStore.getState().navigateToPane(paneId)} />
          ) : undefined,
        });
      }),
    [toast],
  );
  return null;
}
