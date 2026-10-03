import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { useStore } from '../state/store';
import { CONNECTION_STATE_LABEL } from '../lib/connectionState';

export function ConnectionBanner() {
  const state = useStore((state) => state.controlConnectionState);
  if (state === 'connected') return null;
  return (
    <Dialog isOpen purpose="required" onOpenChange={() => {}}>
      <DialogHeader
        title={state === 'connecting' ? 'Connecting' : 'Connection lost'}
        subtitle={CONNECTION_STATE_LABEL[state]}
      />
    </Dialog>
  );
}
