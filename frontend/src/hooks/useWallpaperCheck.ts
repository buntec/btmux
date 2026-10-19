import { useEffect, useState } from 'react';
import type { WallpaperCheck } from '../generated/protocol';

export type WallpaperStatus = { type: 'error' | 'success'; message?: string };

const DEBOUNCE_MS = 500;

/** Asks the server, after typing pauses, whether `source` can be a wallpaper. */
export function useWallpaperCheck(source: string): WallpaperStatus | undefined {
  const [status, setStatus] = useState<WallpaperStatus>();
  useEffect(() => {
    setStatus(undefined);
    if (!source.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/wallpaper/check?source=${encodeURIComponent(source)}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Could not check the wallpaper (HTTP ${response.status})`);
          return response.json() as Promise<WallpaperCheck>;
        })
        .then(({ error }) => setStatus(error ? { type: 'error', message: error } : { type: 'success' }))
        .catch((error: Error) => {
          if (!controller.signal.aborted) setStatus({ type: 'error', message: error.message });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source]);
  return status;
}
