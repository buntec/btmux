import { expect, test } from 'bun:test';
import { buildUsageRows, resolveFocusedUsage, usageParentIndex } from './src/lib/paneUsage';
import type { PortInfo, ProcessInfo } from './src/protocol/process-messages';
import type { SessionState } from './src/state/types';

const pane = (id: string, title: string | null = null) => ({ id, title, cwd: `/${id}` });
const windowOf = (id: string, panes: ReturnType<typeof pane>[]) => ({ id, name: id, panes });
const sessions = [
  { id: 's1', name: 'one', windows: [windowOf('w1', [pane('p1', 'vim'), pane('p2')]), windowOf('w2', [pane('p3')])] },
  { id: 's2', name: 'two', windows: [windowOf('w3', [pane('p4')])] },
] as unknown as SessionState[];

const proc = (pid: number, pane_id: string | null, cpu: number, memory: number, name = 'x'): ProcessInfo => ({
  pid,
  parent_pid: 1,
  name,
  command: name,
  cpu,
  memory,
  virtual_memory: 0,
  status: 'run',
  user: null,
  start_time: 1,
  run_time: 1,
  disk_read: cpu * 10,
  disk_write: cpu * 100,
  pane_id,
});
const processes = [proc(1, 'p1', 1, 100), proc(2, 'p1', 2, 200, 'node'), proc(3, 'p2', 4, 400), proc(4, 'p3', 8, 800)];
processes.push(proc(5, null, 16, 1600));

const socket = (pid: number | null, local_port: number, state = 'LISTEN', protocol = 'TCP'): PortInfo => ({
  pid,
  protocol,
  local_address: '127.0.0.1',
  local_port,
  remote_address: null,
  state,
});

// Fold toggles that open every session, plus `extra`.
const open = (...extra: string[]) => new Set(['session:s1', 'session:s2', ...extra]);
const keys = (toggles: Set<string>, ports: PortInfo[] = []) =>
  buildUsageRows(sessions, processes, ports, toggles).map((row) => row.key);

test('sessions start folded, with their sums', () => {
  const rows = buildUsageRows(sessions, processes, [], new Set());
  expect(rows.map((row) => row.key)).toEqual(['session:s1', 'session:s2']);
  expect(rows[0].usage!.cpu).toBe(15);
  expect(rows[0].hasChildren).toBe(true);
  expect(keys(new Set(['session:s2']))).toEqual(['session:s1', 'session:s2', 'window:w3', 'pane:p4']);
});

test('sums usage up through windows and sessions', () => {
  const rows = buildUsageRows(sessions, processes, [], open());
  const usage = (key: string) => rows.find((row) => row.key === key)!.usage!;
  expect(usage('pane:p1')).toEqual({ cpu: 3, memory: 300, diskRead: 30, diskWrite: 300, processes: 2, ports: 0 });
  expect(usage('window:w1').cpu).toBe(7);
  expect(usage('window:w2').cpu).toBe(8);
  expect(usage('session:s1')).toEqual({
    cpu: 15,
    memory: 1500,
    diskRead: 150,
    diskWrite: 1500,
    processes: 4,
    ports: 0,
  });
  // Unstarted panes have no processes; processes outside panes count nowhere.
  expect(usage('session:s2').processes).toBe(0);
});

test('names untitled panes by position', () => {
  const rows = buildUsageRows(sessions, processes, [], open());
  expect(rows.find((row) => row.key === 'pane:p1')!.label).toBe('vim');
  expect(rows.find((row) => row.key === 'pane:p2')!.label).toBe('pane 2');
});

test('folding hides descendants but keeps sums', () => {
  expect(keys(open('window:w1'))).toEqual([
    'session:s1',
    'window:w1',
    'window:w2',
    'pane:p3',
    'session:s2',
    'window:w3',
    'pane:p4',
  ]);
  const rows = buildUsageRows(sessions, processes, [], open('window:w1'));
  expect(rows[1].usage!.cpu).toBe(7);
});

test('lists listeners under their pane, once per address', () => {
  const ports = [
    socket(2, 5173),
    // Forked workers share a listener.
    socket(1, 5173),
    socket(1, 4000),
    socket(1, 53, 'BOUND', 'UDP'),
    // Established connections and unowned or outside sockets aren't listed.
    socket(1, 5173, 'ESTABLISHED'),
    socket(null, 9000),
    socket(5, 9001),
  ];
  const rows = buildUsageRows(sessions, processes, ports, open());
  const listed = rows.filter((row) => row.kind === 'port');
  expect(listed.map((row) => row.label)).toEqual(['UDP 127.0.0.1:53', 'TCP 127.0.0.1:4000', 'TCP 127.0.0.1:5173']);
  expect(listed.at(-1)!.detail).toBe('node, x');
  expect(rows.find((row) => row.key === 'pane:p1')!.usage!.ports).toBe(3);
  expect(rows.find((row) => row.key === 'window:w1')!.usage!.ports).toBe(3);
  expect(rows.find((row) => row.key === 'session:s1')!.usage!.ports).toBe(3);
  expect(rows.find((row) => row.key === 'pane:p1')!.hasChildren).toBe(true);
  expect(keys(open('pane:p1'), ports).some((key) => key.startsWith('port:'))).toBe(false);
});

test('formats IPv6 listeners with brackets', () => {
  const rows = buildUsageRows(sessions, processes, [{ ...socket(1, 80), local_address: '::1' }], open());
  expect(rows.find((row) => row.kind === 'port')!.label).toBe('TCP [::1]:80');
});

test('focus survives by key, then by position', () => {
  const rows = buildUsageRows(sessions, processes, [], open());
  expect(resolveFocusedUsage(rows, 'pane:p2', 0)).toBe('pane:p2');
  expect(resolveFocusedUsage(rows, 'gone', 2)).toBe(rows[2].key);
  expect(resolveFocusedUsage(rows, 'gone', 99)).toBe(rows.at(-1)!.key);
  expect(resolveFocusedUsage(rows, null, 0)).toBe(rows[0].key);
  expect(resolveFocusedUsage([], 'pane:p2', 0)).toBeNull();
});

test('finds the parent row', () => {
  const rows = buildUsageRows(sessions, processes, [], open());
  const index = (key: string) => rows.findIndex((row) => row.key === key);
  expect(usageParentIndex(rows, index('pane:p2'))).toBe(index('window:w1'));
  expect(usageParentIndex(rows, index('window:w2'))).toBe(index('session:s1'));
  expect(usageParentIndex(rows, index('session:s2'))).toBe(-1);
});
