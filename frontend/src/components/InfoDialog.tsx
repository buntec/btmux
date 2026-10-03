import { useEffect, useState } from 'react';
import type { ServerInfo } from '../generated/protocol';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Alert, AlertDescription } from './ui/alert';

export function InfoDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/info', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load server information (${response.status}).`);
        setInfo(await response.json());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Could not load server information.');
      });
    return () => controller.abort();
  }, []);

  const rows: [string, string | null][] = info
    ? [
        ['Version', info.version],
        ['Profile', info.profile ?? 'default'],
        ['Config file', info.config_file],
        ['State file', info.state_file],
        ['Token file', info.token_file],
        ['Credential source', info.token_source],
        ['Listening address', info.listen_address],
        ['Executable', info.executable],
      ]
    : [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto" onKeyDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>About btmux</DialogTitle>
          <DialogDescription>Server version and runtime configuration.</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !info ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading server information…
          </p>
        ) : (
          <dl className="flex flex-col gap-4 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono select-text">{value ?? 'Unavailable'}</dd>
              </div>
            ))}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
