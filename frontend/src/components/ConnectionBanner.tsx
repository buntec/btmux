import { useStore } from '../state/store';
import { CONNECTION_STATE_LABEL } from '../lib/connectionState';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

// Shown when the /ws/control socket is down (e.g. the server went away). The
// frontend holds no canonical state, so while disconnected the UI is stale;
// the socket auto-reconnects every 2s (see useControlSocket.ts). The dialog is
// intentionally not dismissible because interaction cannot be sent while the
// control socket is unavailable.
export function ConnectionBanner() {
  const state = useStore((s) => s.controlConnectionState);
  if (state === 'connected') return null;

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle>{state === 'connecting' ? 'Connecting' : 'Connection lost'}</DialogTitle>
          <DialogDescription aria-live="polite">{CONNECTION_STATE_LABEL[state]}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
