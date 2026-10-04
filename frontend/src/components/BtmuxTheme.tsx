import { useMemo, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import type { Theme as TerminalTheme } from '../state/types';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { useStore } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { STARTUP_THEME } from '../state/startupTheme';
import { getAnimations, getTerminalFontFamily, getTerminalFontWeight } from '../state/configDefaults';
import { createBtmuxTheme, terminalColorMode } from '../lib/astryx-theme';

const toastOptions = { position: 'topEnd' as const };

// Config including the open settings preview.
function useEffectiveConfig() {
  const config = useStore((state) => state.config);
  const preview = useStore((state) => state.configPreview);
  const settingsOpen = useStore((state) => state.settingsOpen);
  return settingsOpen ? (preview ?? config) : config;
}

export function useTerminalPalette(): TerminalTheme {
  const effective = useEffectiveConfig();
  return effective ? (effective.theme ?? DEFAULT_THEME) : STARTUP_THEME;
}

export function BtmuxTheme({ children }: { children: ReactNode }) {
  const effective = useEffectiveConfig();
  const palette = useTerminalPalette();
  const family = getTerminalFontFamily(effective);
  const weight = getTerminalFontWeight(effective);
  const animations = getAnimations(effective);
  const theme = useMemo(
    () => createBtmuxTheme(palette, family, weight, animations),
    [palette, family, weight, animations],
  );
  return (
    <Theme theme={theme} mode={terminalColorMode(palette)}>
      <LayerProvider toast={toastOptions}>{children}</LayerProvider>
    </Theme>
  );
}
