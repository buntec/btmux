import { useStore } from '../state/store';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

// Shown when the /ws/control socket is down (e.g. the server went away). The
// frontend holds no canonical state, so while disconnected the UI is stale;
// the socket auto-reconnects every 2s (see useControlSocket.ts). The dialog is
// intentionally not dismissible because interaction cannot be sent while the
// control socket is unavailable.
export function ConnectionBanner() {
  const connected = useStore((s) => s.controlConnected);

  return (
    <Dialog open={!connected}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle>Connection lost</DialogTitle>
          <DialogDescription aria-live="polite">Trying to reconnect…</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
