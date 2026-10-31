import { expect, test } from 'bun:test';
import { cleanRenderer } from './src/lib/clientInfo';

test('cleans ANGLE renderer strings', () => {
  expect(cleanRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)')).toBe('Apple M4 Max');
  expect(cleanRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(
    'NVIDIA GeForce RTX 3080',
  );
  expect(cleanRenderer('ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)')).toBe(
    'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
  );
  expect(cleanRenderer('Apple GPU')).toBe('Apple GPU');
});
