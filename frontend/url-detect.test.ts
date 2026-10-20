// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { findUrls } from './src/lib/urlDetect';

const urls = (s: string) => findUrls(s).map((m) => m.url);

test('plain URLs', () => {
  expect(urls('see https://example.com/a?b=1#c now')).toEqual(['https://example.com/a?b=1#c']);
  expect(urls('http://localhost:5173 and https://x.io')).toEqual(['http://localhost:5173', 'https://x.io']);
  expect(urls('no url here, ftp://x.io, https://')).toEqual([]);
});

test('trailing punctuation and brackets', () => {
  expect(urls('Visit https://example.com.')).toEqual(['https://example.com']);
  expect(urls('(see https://example.com/x)')).toEqual(['https://example.com/x']);
  expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  expect(urls('[link](https://example.com/y)')).toEqual(['https://example.com/y']);
  expect(urls('"https://example.com/q"')).toEqual(['https://example.com/q']);
});

test('TUI borders', () => {
  expect(urls('│ https://example.com/z│')).toEqual(['https://example.com/z']);
});

test('indices', () => {
  expect(findUrls('go https://a.io/b, ok')).toEqual([{ url: 'https://a.io/b', start: 3, end: 17 }]);
});
