import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { Layout, LayoutContent, LayoutFooter, HStack } from '@astryxdesign/core/Layout';

interface CreateEntryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateEntryModal({ open, onOpenChange, onCreate }: CreateEntryModalProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setCreating(false);
    setError(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!creating) onOpenChange(nextOpen);
  };

  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width={480}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void create();
        }
      }}
    >
      <Layout
        header={<DialogHeader title="New file or folder" onOpenChange={handleOpenChange} />}
        content={
          <LayoutContent padding={4}>
            <FormLayout>
              <TextInput
                ref={inputRef}
                label="Name"
                value={name}
                onChange={setName}
                hasAutoFocus
                isDisabled={creating}
                placeholder="foo/bar/baz.txt, or end with / for a folder"
              />
              {error && <Banner status="error" title={error} />}
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" onClick={() => handleOpenChange(false)} isDisabled={creating} />
              <Button
                label="Create"
                variant="primary"
                onClick={() => void create()}
                isLoading={creating}
                isDisabled={!name.trim()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
