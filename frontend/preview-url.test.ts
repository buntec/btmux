// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { previewUrl } from './src/lib/previewUrl';

test('Unix paths', () => {
  expect(previewUrl('/tmp/a page/b#c.html')).toBe('/api/preview/tmp/a%20page/b%23c.html');
  expect(previewUrl('/tmp/back\\slash.html')).toBe('/api/preview/tmp/back%5Cslash.html');
});

test('Windows drive paths', () => {
  expect(previewUrl('C:/Users/me/a.html')).toBe('/api/preview/C%3A/Users/me/a.html');
  expect(previewUrl('C:\\Users\\me\\a.html')).toBe('/api/preview/C%3A/Users/me/a.html');
});

test('UNC paths keep their root', () => {
  const url = '/api/preview/%2F%2Fserver/share/dir/a.html';
  expect(previewUrl('//server/share/dir/a.html')).toBe(url);
  expect(previewUrl('\\\\server\\share\\dir\\a.html')).toBe(url);
  // Relative links stay on the share.
  expect(new URL('../b.png', `http://x${url}`).pathname).toBe('/api/preview/%2F%2Fserver/share/b.png');
});
