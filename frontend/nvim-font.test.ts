// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { cssFamily, parseGuifont } from './src/lib/nvimFont';

test('parses families and a point size', () => {
  expect(parseGuifont('JetBrains Mono,Symbols Nerd Font:h15')).toEqual({
    families: ['JetBrains Mono', 'Symbols Nerd Font'],
    size: 20,
  });
  expect(parseGuifont('Fira Code:h13.5:b')).toEqual({ families: ['Fira Code'], size: 18 });
});

test('accepts escaped spaces, underscores and escaped commas', () => {
  expect(parseGuifont('Source\\ Code\\ Pro')).toEqual({ families: ['Source Code Pro'], size: null });
  expect(parseGuifont('Iosevka_Term:h12')).toEqual({ families: ['Iosevka Term'], size: 16 });
  expect(parseGuifont('Odd\\,Name,Other').families).toEqual(['Odd,Name', 'Other']);
});

test('empty and "*" keep the btmux font', () => {
  expect(parseGuifont('')).toEqual({ families: [], size: null });
  expect(parseGuifont('*:h14')).toEqual({ families: [], size: 18.67 });
});

test('quotes family names when CSS needs it', () => {
  expect(cssFamily('monospace')).toBe('monospace');
  expect(cssFamily('JetBrains Mono')).toBe('"JetBrains Mono"');
  expect(cssFamily('3270')).toBe('"3270"');
  expect(cssFamily('Weird"Name')).toBe('"Weird\\"Name"');
});
