import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field';

// Vite serves the development HTML itself, so it cannot issue the backend's
// browser password challenge. This gate authenticates before opening sockets.
export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/sessions', { signal: controller.signal, cache: 'no-store' })
      .then((response) => {
        setAuthenticated(response.ok);
        if (!response.ok && response.status !== 401)
          setError('Connection refused. Check the server’s allowed public URLs.');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError('Could not reach btmux. Check that the server is running.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    const requireAuth = () => setAuthenticated(false);
    window.addEventListener('btmux-auth-required', requireAuth);
    return () => {
      controller.abort();
      window.removeEventListener('btmux-auth-required', requireAuth);
    };
  }, []);
  if (authenticated) return children;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const response = await fetch('/api/sessions', {
              headers: { Authorization: `Bearer ${token.trim()}` },
              cache: 'no-store',
            });
            if (!response.ok)
              throw new Error(
                response.status === 401
                  ? 'The access token is incorrect.'
                  : 'Connection refused. Check the server’s allowed public URLs.',
              );
            setToken('');
            setAuthenticated(true);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not connect.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="text-xl font-semibold">Connect to btmux</h1>
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="access-token">Access token</FieldLabel>
            <Input
              id="access-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby="access-help"
            />
            <FieldDescription id="access-help">Use the token from the file shown when btmux starts.</FieldDescription>
            <FieldError>{error}</FieldError>
          </Field>
          <Button type="submit" disabled={busy || !token.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </FieldGroup>
      </form>
    </main>
  );
}
