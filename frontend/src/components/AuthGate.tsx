import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';

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
    <AppShell height="fill" contentPadding={6}>
      <Layout
        contentWidth={400}
        content={
          <LayoutContent className="flex items-center justify-center">
            <form
              id="access-token"
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
              <Heading level={1}>Connect to btmux</Heading>
              <FormLayout>
                <TextInput
                  label="Access token"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={setToken}
                  isRequired
                  isDisabled={busy}
                  description="Use the token from the file shown when btmux starts."
                  status={error ? { type: 'error', message: error } : undefined}
                />
                <Button
                  label={busy ? 'Connecting…' : 'Connect'}
                  type="submit"
                  variant="primary"
                  isDisabled={busy || !token.trim()}
                />
              </FormLayout>
            </form>
          </LayoutContent>
        }
      />
    </AppShell>
  );
}
