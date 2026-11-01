import { useEffect, useState } from 'react';

/** `devicePixelRatio`, updated on page zoom and moves between displays. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const update = () => setDpr(window.devicePixelRatio || 1);
    update();
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    query.addEventListener('change', update);
    // WKWebView page zoom fires resize but not the query's change (WebKit bug 124862).
    window.addEventListener('resize', update);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [dpr]);
  return dpr;
}
