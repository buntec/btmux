import { useEffect } from 'react';
import { getBackdropBlur, getBackdropDim } from '../state/configDefaults';
import type { ClientConfig } from '../state/types';

/**
 * Publishes the `backdrop-blur` / `backdrop-dim` config as CSS variables for
 * the global `dialog::backdrop` rule in index.css, which every modal shares.
 * `config` is the effective one, so the settings page previews them live.
 */
export function useModalBackdrop(config: ClientConfig | null): void {
  const blur = getBackdropBlur(config);
  const dim = getBackdropDim(config);
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--btm-backdrop-blur', `${blur}px`);
    style.setProperty('--btm-backdrop-dim', String(dim));
  }, [blur, dim]);
}
