import { describe, expect, test } from 'bun:test';
import { createBtmuxTheme, readableColor, contrastRatio, terminalColorMode } from './src/lib/astryx-theme';
import { DEFAULT_THEME } from './src/state/defaultTheme';

describe('terminal-derived Astryx theme', () => {
  test('uses the same palette and font for UI, headings, and code', () => {
    const theme = createBtmuxTheme(DEFAULT_THEME, 'JetBrains Mono', 300, true);
    expect(theme.tokens['--color-background-body']).toBe(DEFAULT_THEME.background);
    expect(theme.tokens['--color-accent']).toBe(DEFAULT_THEME.blue);
    expect(theme.tokens['--font-weight-normal']).toBe('300');
    for (const role of ['body', 'heading', 'code'] as const) {
      expect(theme.tokens[`--font-family-${role}`]).toContain('JetBrains Mono');
    }
    expect(theme.localTokens?.['--astryx-theme-neutral-color-status-fill-error']).toBe(DEFAULT_THEME.red);
  });

  test('adopts light palettes and maintains readable secondary and status text', () => {
    const palette = { ...DEFAULT_THEME, background: '#ffffff', foreground: '#333333' };
    expect(terminalColorMode(DEFAULT_THEME)).toBe('dark');
    expect(terminalColorMode(palette)).toBe('light');
    const theme = createBtmuxTheme(palette, 'Fira Code', 400, true);
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
