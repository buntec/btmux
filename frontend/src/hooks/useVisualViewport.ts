import { useEffect } from 'react';
import { isTouchPrimary } from '../lib/touch';

/**
 * Fit the app to the visual viewport on touch devices. iOS doesn't resize the
 * layout viewport for the on-screen keyboard; it scrolls the page to show the
 * focused input, which would push the panes under the keyboard.
 */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !isTouchPrimary()) return;
    const root = document.documentElement;
    const update = () => {
      // Unzoomed height: pinch zoom shrinks the viewport too, but mustn't resize panes.
      const height = viewport.height * viewport.scale;
      root.style.setProperty('--btm-viewport-height', `${height}px`);
      // The keyboard covers the home indicator: drop the bottom safe-area inset.
      if (root.clientHeight - height > 100) root.style.setProperty('--btm-safe-bottom', '0px');
      else root.style.removeProperty('--btm-safe-bottom');
      if (window.scrollY) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--btm-viewport-height');
      root.style.removeProperty('--btm-safe-bottom');
    };
  }, []);
}
