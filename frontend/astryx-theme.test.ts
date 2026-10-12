import { describe, expect, test } from 'bun:test';
import { createBtmuxTheme, readableColor, contrastRatio, terminalColorMode } from './src/lib/astryx-theme';
import { FALLBACK_THEME } from './src/state/startupTheme';

describe('terminal-derived Astryx theme', () => {
  test('uses the palette, sans for UI and headings, and the terminal font for code', () => {
    const theme = createBtmuxTheme(FALLBACK_THEME, 'JetBrains Mono', true);
    expect(theme.tokens['--color-background-body']).toBe(FALLBACK_THEME.background);
    expect(theme.tokens['--color-accent']).toBe(FALLBACK_THEME.blue);
    expect(theme.tokens['--font-family-body']).toContain('Geist Variable');
    expect(theme.tokens['--font-family-heading']).toContain('Geist Variable');
    expect(theme.tokens['--font-family-code']).toContain('JetBrains Mono');
    expect(theme.localTokens?.['--astryx-theme-neutral-color-status-fill-error']).toBe(FALLBACK_THEME.red);
  });

  test('adopts light palettes and maintains readable secondary and status text', () => {
    const palette = { ...FALLBACK_THEME, background: '#ffffff', foreground: '#333333' };
    expect(terminalColorMode(FALLBACK_THEME)).toBe('dark');
    expect(terminalColorMode(palette)).toBe('light');
    const theme = createBtmuxTheme(palette, 'Fira Code', true);
    const background = theme.tokens['--color-background-popover'] as string;
    for (const token of [
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-accent',
      '--color-error',
      '--color-warning',
      '--color-success',
    ] as const) {
      expect(contrastRatio(theme.tokens[token] as string, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('keeps sufficiently contrasted colors and repairs low contrast in either mode', () => {
    expect(readableColor('#ffffff', '#000000')).toBe('#ffffff');
    for (const background of ['#eeeeee', '#181818', '#808080']) {
      expect(contrastRatio(readableColor('#888888', background), background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
  });
});
