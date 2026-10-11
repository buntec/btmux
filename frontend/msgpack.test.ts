// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { encode, MsgpackStream } from './src/lib/msgpack';

const roundtrip = (value: unknown) => new MsgpackStream().push(encode(value));

test('round-trips scalars across encoding widths', () => {
  const values = [
    null,
    true,
    false,
    0,
    127,
    128,
    255,
    256,
    65535,
    65536,
    0xffffffff,
    -1,
    -32,
    -33,
    -128,
    -129,
    -32768,
    -32769,
    -0x80000000,
    1.5,
    -2.25,
  ];
  for (const value of values) expect(roundtrip(value)).toEqual([value]);
});

test('round-trips strings by UTF-8 length', () => {
  for (const s of ['', 'a', 'ü漢字🙂', 'x'.repeat(31), 'x'.repeat(32), 'x'.repeat(256), 'x'.repeat(70000)]) {
    expect(roundtrip(s)).toEqual([s]);
  }
});

test('round-trips nested arrays and maps of every header size', () => {
  const big = Array.from({ length: 20 }, (_, i) => i);
  const map = Object.fromEntries(big.map((i) => [`k${i}`, i]));
  const value = [0, 'nvim_ui_attach', [80, 24, { rgb: true, ext_linegrid: true }], big, map];
  expect(roundtrip(value)).toEqual([value]);
});

test('round-trips binary data', () => {
  const [out] = roundtrip(new Uint8Array([1, 2, 255]));
  expect(Array.from(out as Uint8Array)).toEqual([1, 2, 255]);
});

test('decodes messages split at any byte boundary', () => {
  const messages = [[2, 'redraw', [['flush']]], [1, 7, null, 'ok'], 'tail'];
  const bytes = new Uint8Array(messages.flatMap((m) => Array.from(encode(m))));
  for (let cut = 0; cut <= bytes.length; cut++) {
    const stream = new MsgpackStream();
    const out = [...stream.push(bytes.slice(0, cut)), ...stream.push(bytes.slice(cut))];
    expect(out).toEqual(messages);
  }
});

test('decodes messages fed one byte at a time', () => {
  const messages = [[2, 'redraw', [['grid_line', [1, 0, 0, [['é', 3, 2]], false]]]], 42];
  const bytes = new Uint8Array(messages.flatMap((m) => Array.from(encode(m))));
  const stream = new MsgpackStream();
  const out = Array.from(bytes).flatMap((b) => stream.push(new Uint8Array([b])));
  expect(out).toEqual(messages);
});

test('decodes large messages across many frames, keeping earlier binary data intact', () => {
  const stream = new MsgpackStream();
  stream.push(encode('x'.repeat(100)));
  const [first] = stream.push(encode(new Uint8Array([1, 2, 3])));
  // Reuses the buffer in place.
  expect(Array.from(stream.push(encode(new Uint8Array([7, 7, 7])))[0] as Uint8Array)).toEqual([7, 7, 7]);
  const big = [2, 'redraw', [['grid_line', ...Array.from({ length: 2000 }, (_, r) => [2, r, 0, [['x', 1, 80]]])]]];
  const bytes = new Uint8Array([...encode(big), ...encode(new Uint8Array(70_000).fill(9)), ...encode('tail')]);
  const out: unknown[] = [];
  for (let o = 0; o < bytes.length; o += 4096) out.push(...stream.push(bytes.subarray(o, o + 4096)));
  expect(out[0]).toEqual(big);
  expect((out[1] as Uint8Array).every((x) => x === 9)).toBe(true);
  expect(out[2]).toBe('tail');
  expect(Array.from(first as Uint8Array)).toEqual([1, 2, 3]);
});

test('decodes Neovim ext types (buffer/window handles) and 64-bit ints', () => {
  // fixext1 type 0 (Buffer) with payload 0x05; uint64 2^32; int64 -2^32.
  const bytes = new Uint8Array([
    0xd4, 0x00, 0x05,
    0xcf, 0, 0, 0, 1, 0, 0, 0, 0,
    0xd3, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0,
  ]);
  const [ext, big, negative] = new MsgpackStream().push(bytes) as [{ type: number; data: Uint8Array }, number, number];
  expect(ext.type).toBe(0);
  expect(Array.from(ext.data)).toEqual([5]);
  expect(big).toBe(2 ** 32);
  expect(negative).toBe(-(2 ** 32));
});

test('rejects unknown type bytes', () => {
  expect(() => new MsgpackStream().push(new Uint8Array([0xc1]))).toThrow();
});
