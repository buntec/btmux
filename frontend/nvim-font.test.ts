// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { cssFamily, parseGuifont } from './src/lib/nvimFont';

test('parses families and a point size', () => {
  expect(parseGuifont('JetBrains Mono,Symbols Nerd Font:h15')).toMatchObject({
    families: ['JetBrains Mono', 'Symbols Nerd Font'],
    size: 20,
  });
  expect(parseGuifont('Fira Code:h13.5')).toMatchObject({ families: ['Fira Code'], size: 18 });
});

test('parses bold, italic, and a width offset in points', () => {
  expect(parseGuifont('Fira Code:h12:b')).toEqual({
    families: ['Fira Code'],
    size: 16,
    bold: true,
    italic: false,
    width: 0,
  });
  expect(parseGuifont('Fira Code:i:w-0.75')).toMatchObject({ size: null, bold: false, italic: true, width: -1 });
});

test('accepts escaped spaces, underscores and escaped commas', () => {
  expect(parseGuifont('Source\\ Code\\ Pro')).toMatchObject({ families: ['Source Code Pro'], size: null });
  expect(parseGuifont('Iosevka_Term:h12')).toMatchObject({ families: ['Iosevka Term'], size: 16 });
  expect(parseGuifont('Odd\\,Name,Other').families).toEqual(['Odd,Name', 'Other']);
});

test('empty and "*" keep the btmux font', () => {
  expect(parseGuifont('')).toMatchObject({ families: [], size: null });
  expect(parseGuifont('*:h14')).toMatchObject({ families: [], size: 18.67 });
});

test('quotes family names when CSS needs it', () => {
  expect(cssFamily('monospace')).toBe('monospace');
  expect(cssFamily('JetBrains Mono')).toBe('"JetBrains Mono"');
  expect(cssFamily('3270')).toBe('"3270"');
  expect(cssFamily('Weird"Name')).toBe('"Weird\\"Name"');
});
