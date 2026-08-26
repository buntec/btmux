import { useEffect } from 'react';
import { useStore } from '../state/store';
import { getTerminalFontFamily, getTerminalFontWeight } from '../state/configDefaults';

export function useFontLoader() {
  const config = useStore((s) => s.config);
  const fontFamily = getTerminalFontFamily(config);
  const fontWeight = getTerminalFontWeight(config);
  const showToast = useStore((s) => s.showToast);

  useEffect(() => {
    let cancelled = false;
    const boldWeight = Math.min(fontWeight + 200, 900);
    const spec = (w: number) => `${w} 16px "${fontFamily}"`;

    Promise.all([document.fonts.load(spec(fontWeight)), document.fonts.load(spec(boldWeight))]).then((results) => {
      if (cancelled) return;
      const loaded = results[0].length > 0 || results[1].length > 0;
      if (!loaded) {
        showToast(`Font "${fontFamily}" not found — using fallback`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontWeight, showToast]);
}
