import { expect, test } from 'bun:test';
import {
  buildProcessRows,
  flattenProcessTree,
  nextProcessSortMode,
  PROCESS_SORT_MODES,
  resolveFocusedPid,
  type ProcessSortMode,
} from './src/lib/processTree';
import type { ProcessInfo } from './src/protocol/process-messages';

const process = (pid: number, parent_pid: number | null, cpu: number): ProcessInfo => ({
  pid,
  parent_pid,
  name: `process-${pid}`,
  command: `process-${pid}`,
  cpu,
  memory: 0,
  virtual_memory: 0,
  status: 'sleeping',
  user: null,
  start_time: 1,
  run_time: 0,
});

test('flattens processes in PID order by default and preserves indentation', () => {
  const rows = flattenProcessTree(
    [process(1, null, 1), process(3, 1, 20), process(2, 1, 5), process(4, null, 10)],
    new Set(),
  );

  expect(rows.map((row) => [row.process.pid, row.depth])).toEqual([
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 0],
  ]);
});

test('sorts each tree level by the selected mode with PID tie-breaks', () => {
  const processes = [
    { ...process(1, null, 20), memory: 100, virtual_memory: 500, run_time: 10, user: 'z' },
    { ...process(2, null, 80), memory: 300, virtual_memory: 200, run_time: 30, user: 'a' },
    { ...process(3, null, 80), memory: 200, virtual_memory: 900, run_time: 20, user: 'a' },
  ];

  const sorted = (mode: ProcessSortMode) =>
    flattenProcessTree(processes, new Set(), mode).map((row) => row.process.pid);

  expect(sorted('cpu')).toEqual([2, 3, 1]);
  expect(sorted('memory')).toEqual([2, 3, 1]);
  expect(sorted('elapsed')).toEqual([2, 3, 1]);
  expect(sorted('pid')).toEqual([1, 2, 3]);
  expect(sorted('user')).toEqual([2, 3, 1]);
  expect(sorted('virtual-memory')).toEqual([3, 1, 2]);
});

test('flat mode sorts all processes globally and removes tree indentation', () => {
  const rows = buildProcessRows(
    [process(1, null, 1), process(2, 1, 90), process(3, null, 50)],
    new Set([1]),
    'cpu',
    false,
  );

  expect(rows.map((row) => [row.process.pid, row.depth, row.hasChildren])).toEqual([
    [2, 0, false],
    [3, 0, false],
    [1, 0, false],
  ]);
});

test('cycles sort modes in the displayed order', () => {
  let mode: ProcessSortMode = 'cpu';
  const cycled = PROCESS_SORT_MODES.map(() => {
    const next = nextProcessSortMode(mode);
    mode = next;
    return next;
  });

  expect(cycled).toEqual(['memory', 'elapsed', 'pid', 'user', 'virtual-memory', 'cpu']);
});

test('folding a process hides all descendants', () => {
  const rows = flattenProcessTree([process(1, null, 1), process(2, 1, 2), process(3, 2, 3)], new Set([1]));

  expect(rows.map((row) => row.process.pid)).toEqual([1]);
  expect(rows[0]?.hasChildren).toBe(true);
});

test('filters flat rows by PID and command details', () => {
  const processes = [process(1, null, 1), process(2, 1, 2), process(3, null, 3)];
  const filtered = (query: string) =>
    buildProcessRows(processes, new Set(), 'pid', false, query).map((row) => row.process.pid);

  expect(filtered('PROCESS-2')).toEqual([2]);
  expect(filtered('3')).toEqual([3]);
});

test('tree filtering keeps ancestors as context and finds matches in folded subtrees', () => {
  const processes = [process(1, null, 1), process(2, 1, 2), process(3, 2, 3), process(4, 1, 4), process(5, null, 5)];
  const rows = buildProcessRows(processes, new Set([1]), 'pid', true, 'process-3');

  expect(rows.map((row) => [row.process.pid, row.depth, row.match])).toEqual([
    [1, 0, false],
    [2, 1, false],
    [3, 2, true],
  ]);
});

test('snapshot updates keep the cursor row unless following', () => {
  const rows = buildProcessRows([process(1, null, 90), process(2, null, 50), process(3, null, 10)], new Set(), 'cpu', false);

  // Focused PID 3 moved away from row 1: stay on the row.
  expect(resolveFocusedPid(rows, 3, 1, true)).toBe(2);
  // Following, or after a non-snapshot change: stay on the PID.
  expect(resolveFocusedPid(rows, 3, 1, false)).toBe(3);
  // Focused process exited: fall back to the same row, clamped.
  expect(resolveFocusedPid(rows, 99, 5, false)).toBe(3);
  expect(resolveFocusedPid([], 3, 0, false)).toBeNull();
});

test('processes with an unknown start time sort last by elapsed', () => {
  const processes = [
    { ...process(1, null, 0), start_time: 0, run_time: 1_790_000_000 },
    { ...process(2, null, 0), run_time: 10 },
    { ...process(3, null, 0), run_time: 20 },
  ];

  expect(buildProcessRows(processes, new Set(), 'elapsed', false).map((row) => row.process.pid)).toEqual([3, 2, 1]);
});
