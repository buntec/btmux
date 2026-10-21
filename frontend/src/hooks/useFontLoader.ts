import { useEffect } from 'react';
import { useStore } from '../state/store';
import { getTerminalFontFamily, getTerminalFontWeight } from '../state/configDefaults';

// document.fonts reports only web fonts; detect installed ones by their metrics.
function isInstalled(family: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return true;
  const sample = 'mmmmmmmmmmlli10OO@#';
  return ['monospace', 'serif', 'sans-serif'].some((generic) => {
    context.font = `72px ${generic}`;
    const fallback = context.measureText(sample).width;
    context.font = `72px "${family}", ${generic}`;
    return context.measureText(sample).width !== fallback;
  });
}

export function useFontLoader() {
  const config = useStore((s) => (s.settingsOpen ? (s.configPreview ?? s.config) : s.config));
  const fontFamily = getTerminalFontFamily(config);
  const fontWeight = getTerminalFontWeight(config);
  const showToast = useStore((s) => s.showToast);

  useEffect(() => {
    let cancelled = false;
    const boldWeight = Math.min(fontWeight + 200, 900);
    const spec = (w: number) => `${w} 16px "${fontFamily}"`;

    Promise.all([document.fonts.load(spec(fontWeight)), document.fonts.load(spec(boldWeight))]).then((results) => {
      if (cancelled) return;
      const loaded = results[0].length > 0 || results[1].length > 0 || isInstalled(fontFamily);
      if (!loaded) {
        showToast(`Font "${fontFamily}" not found — using fallback`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontWeight, showToast]);
}
