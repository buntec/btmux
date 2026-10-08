import { useEffect, useState } from 'react';
import { getDesktopVersion } from '../lib/desktopApp';

export function useDesktopVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getDesktopVersion().then((v) => current && setVersion(v));
    return () => {
      current = false;
    };
  }, []);
  return version;
}
