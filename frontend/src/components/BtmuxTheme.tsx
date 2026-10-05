import { useMemo, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import type { Theme as TerminalTheme } from '../state/types';
import { ToastLayer } from './ToastLayer';
import { useStore } from '../state/store';
import { STARTUP_THEME } from '../state/startupTheme';
import { getAnimations, getTerminalFontFamily, getTerminalFontWeight } from '../state/configDefaults';
import { createBtmuxTheme, terminalColorMode } from '../lib/astryx-theme';

// Config including the open settings preview.
function useEffectiveConfig() {
  const config = useStore((state) => state.config);
  const preview = useStore((state) => state.configPreview);
  const settingsOpen = useStore((state) => state.settingsOpen);
  return settingsOpen ? (preview ?? config) : config;
}

export function useTerminalPalette(): TerminalTheme {
  const effective = useEffectiveConfig();
  return effective ? effective.theme : STARTUP_THEME;
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
      <ToastLayer>{children}</ToastLayer>
    </Theme>
  );
}
