import { useEffect } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { useStore } from '../state/store';

/** Stays until config.toml loads again; the server keeps the last good config meanwhile. */
export function ConfigErrorBanner() {
  const setOverlay = useStore((state) => state.setOverlay);
  return (
    <Banner
      status="error"
      container="section"
      title="Config error: config.toml was rejected"
      description="btmux keeps using the last valid config, or the defaults, until the file is fixed."
      endContent={
        <Button
          label="Show error"
          size="sm"
          onClick={() => setOverlay({ mode: 'config-error', title: 'Config error' })}
        />
      }
    />
  );
}

export function ConfigErrorDialog({ onClose }: { onClose: () => void }) {
  const error = useStore((state) => state.config?.config_error ?? null);
  // Fixing the file clears the error.
  useEffect(() => {
    if (error === null) onClose();
  }, [error, onClose]);
  const changeOpen = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <Dialog isOpen onOpenChange={changeOpen} maxHeight="85dvh" width={720}>
      <Layout
        header={<DialogHeader title="config.toml was rejected" onOpenChange={changeOpen} />}
        content={
          <LayoutContent padding={4}>
            <Text type="code" className="whitespace-pre-wrap break-words select-text">
              {error}
            </Text>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
