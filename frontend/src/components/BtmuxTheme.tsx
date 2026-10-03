import { useMemo, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { useStore } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { STARTUP_THEME } from '../state/startupTheme';
import { getAnimations, getTerminalFontFamily, getTerminalFontWeight } from '../state/configDefaults';
import { createBtmuxTheme, terminalColorMode } from '../lib/astryx-theme';

const toastOptions = { position: 'topEnd' as const };

export function BtmuxTheme({ children }: { children: ReactNode }) {
  const config = useStore((state) => state.config);
  const preview = useStore((state) => state.configPreview);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const effective = settingsOpen ? (preview ?? config) : config;
  const palette = effective ? (effective.theme ?? DEFAULT_THEME) : STARTUP_THEME;
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
