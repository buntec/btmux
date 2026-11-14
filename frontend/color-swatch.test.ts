import { expect, test } from 'bun:test';
import { splitColor, withAlpha } from './src/components/ColorSwatch';

test('splitColor reads hex colors and their alpha', () => {
  expect(splitColor('#ABC')).toEqual({ rgb: '#aabbcc', alpha: 1 });
  expect(splitColor('#abc8')).toEqual({ rgb: '#aabbcc', alpha: 0x88 / 255 });
  expect(splitColor('#11223300')).toEqual({ rgb: '#112233', alpha: 0 });
});

test('withAlpha keeps nonzero alpha exactly', () => {
  expect(withAlpha('#123456', 1)).toBe('#123456');
  expect(withAlpha('#123456', 0)).toBe('#123456');
  expect(withAlpha('#123456', 0x80 / 255)).toBe('#12345680');
  expect(withAlpha('#123456', 0.501961)).toBe('#12345680');
  expect(withAlpha('#123456', 0.3)).toBe('rgb(18 52 86 / 0.3)');
  expect(withAlpha('#123456', 0.001)).toBe('rgb(18 52 86 / 0.001)');
});
