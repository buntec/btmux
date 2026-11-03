// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import { ScanPool } from './src/lib/scanPool';

/** A pool whose scans stay pending until settled by key. */
function heldPool(limit: number) {
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const pool = new ScanPool((key) => {
    started.push(key);
    return new Promise<void>((resolve, reject) => pending.set(key, { resolve, reject }));
  }, limit);
  const settle = async (keys: Iterable<string>) => {
    for (const key of [...keys]) {
      pending.get(key)!.resolve();
      pending.delete(key);
    }
    await tick();
  };
  return { pool, started, pending, settle };
}

const tick = () => new Promise((resolve) => setTimeout(resolve));
const keys = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const never = () => false;

test('stays within the limit, starting more as scans finish', async () => {
  const { pool, started, pending, settle } = heldPool(8);
  let done = false;
  void pool.run(keys('a', 10), never).then(() => (done = true));
  expect(started).toEqual(keys('a', 8));
  await settle(['a0']);
  expect(started).toEqual(keys('a', 9));
  await settle([...pending.keys()]);
  await settle([...pending.keys()]);
  expect(started).toEqual(keys('a', 10));
  expect(done).toBe(true);
});

test('reopening joins pending scans; only the latest round starts the rest', async () => {
  const { pool, started, pending, settle } = heldPool(8);
  const roots = keys('a', 10);
  const closes = [false, false, false];
  const done = [false, false, false];
  closes.forEach((_, i) => {
    void pool.run(roots, () => closes[i]!).then(() => (done[i] = true));
    if (i < closes.length - 1) closes[i] = true;
  });
  expect(started).toEqual(keys('a', 8));

  await settle([...pending.keys()]);
  expect(started).toEqual(roots);
  expect(done).toEqual([true, true, false]);
  await settle([...pending.keys()]);
  expect(done).toEqual([true, true, true]);
  expect(started).toEqual(roots);
});

test('a changed root list waits for a free slot and joins shared roots', async () => {
  const { pool, started, pending, settle } = heldPool(8);
  let closed = false;
  void pool.run(keys('a', 10), () => closed);
  closed = true;
  let done = false;
  void pool.run(['a0', 'b0', 'b1'], never).then(() => (done = true));
  await tick();
  expect(started).toEqual(keys('a', 8));

  await settle(['a1']);
  expect(started).toEqual([...keys('a', 8), 'b0']);
  await settle([...pending.keys()]);
  expect(started).toEqual([...keys('a', 8), 'b0', 'b1']);
  expect(started).not.toContain('a8');
  expect(done).toBe(false);
  await settle([...pending.keys()]);
  expect(done).toBe(true);
});

test('a stopped round starts nothing more', async () => {
  const { pool, started, pending, settle } = heldPool(2);
  let closed = false;
  let done = false;
  void pool.run(keys('a', 3), () => closed).then(() => (done = true));
  closed = true;
  await settle([...pending.keys()]);
  expect(started).toEqual(keys('a', 2));
  expect(done).toBe(true);
});

test('a failed scan frees its slot and finishes the round', async () => {
  const { pool, started, pending, settle } = heldPool(1);
  let done = false;
  void pool.run(['a', 'b'], never).then(() => (done = true));
  pending.get('a')!.reject(new Error('closed'));
  pending.delete('a');
  await tick();
  expect(started).toEqual(['a', 'b']);
  await settle(['b']);
  expect(done).toBe(true);
});

test('a later round scans a finished key again', async () => {
  const { pool, started, settle } = heldPool(8);
  void pool.run(['a'], never);
  await settle(['a']);
  void pool.run(['a'], never);
  expect(started).toEqual(['a', 'a']);
  await settle(['a']);
});
