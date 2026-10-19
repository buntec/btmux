import { useEffect, useState } from 'react';
import type { WallpaperCheck } from '../generated/protocol';

export type WallpaperStatus = { type: 'error' | 'success'; message?: string };

export interface WallpaperCheckResult {
  status?: WallpaperStatus;
  /** What browsers load for a valid source. */
  url: string | null;
}

const DEBOUNCE_MS = 500;

/** Asks the server, after typing pauses, whether `source` can be a wallpaper. */
export function useWallpaperCheck(source: string): WallpaperCheckResult {
  const [result, setResult] = useState<WallpaperCheckResult>({ url: null });
  useEffect(() => {
    setResult({ url: null });
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
        .then(({ error, url }) =>
          setResult(
            error ? { status: { type: 'error', message: error }, url: null } : { status: { type: 'success' }, url },
          ),
        )
        .catch((error: Error) => {
          if (!controller.signal.aborted) setResult({ status: { type: 'error', message: error.message }, url: null });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source]);
  return result;
}
