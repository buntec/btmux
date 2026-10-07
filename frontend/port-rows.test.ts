import { expect, test } from 'bun:test';
import { buildPortRows, portKey, resolveFocusedPort } from './src/lib/portRows';
import type { PortInfo, ProcessInfo } from './src/protocol/process-messages';
import { useProcessStore } from './src/state/processStore';

const owner: ProcessInfo = {
  pid: 42,
  parent_pid: 1,
  name: 'btmux',
  command: 'btmux --profile dev',
  cpu: 0,
  memory: 0,
  virtual_memory: 0,
  status: 'sleeping',
  user: 'alice',
  start_time: 1,
  run_time: 1,
};
const port = (local_port: number, pid: number | null = 42): PortInfo => ({
  local_port,
  pid,
  protocol: 'TCP',
  local_address: '127.0.0.1',
  remote_address: null,
  state: 'LISTEN',
});

test('sorts ports numerically and retains sockets with unavailable owners', () => {
  const rows = buildPortRows([port(8004), port(80, null), port(443, 99)], [owner], 'port');
  expect(rows.map((row) => row.port.local_port)).toEqual([80, 443, 8004]);
  expect(rows.map((row) => row.process?.pid ?? null)).toEqual([null, null, 42]);
});

test('filters ports by socket fields and process details', () => {
  const ports = [port(8004), { ...port(53, null), protocol: 'UDP', state: 'BOUND' }];
  for (const query of ['8004', 'BTMUX', 'dev', 'alice', 'LISTEN', '42', '127.0.0.1']) {
    expect(buildPortRows(ports, [owner], 'port', query)).toHaveLength(query === '127.0.0.1' ? 2 : 1);
  }
  expect(buildPortRows(ports, [owner], 'port', 'udp')[0]?.port.local_port).toBe(53);
  expect(buildPortRows(ports, [owner], 'port', 'nonexistent')).toHaveLength(0);
});

test('group keys remain stable across addresses, protocols and remote peers', () => {
  expect(portKey(port(80))).not.toBe(portKey(port(443)));
  expect(portKey(port(80))).toBe(portKey({ ...port(80), remote_address: '[::1]:443' }));
  expect(portKey(port(80))).toBe(portKey({ ...port(80), protocol: 'UDP', local_address: '::' }));
  expect(portKey(port(80))).not.toBe(portKey(port(80, 99)));
});

test('focus follows a socket, preserves the cursor row on refresh, and repairs disappearing ports', () => {
  const rows = buildPortRows([port(80), port(443), port(8004)], [owner], 'port');
  const key = rows[2].key;
  expect(resolveFocusedPort(rows, key, 42, 1, false)?.port.local_port).toBe(8004);
  expect(resolveFocusedPort(rows, key, 42, 1, true)?.port.local_port).toBe(443);
  expect(resolveFocusedPort(rows, 'gone', 42, 10, false)?.port.local_port).toBe(8004);
  expect(resolveFocusedPort(rows, null, 42, 0, false)?.port.pid).toBe(42);
  expect(resolveFocusedPort([], key, 42, 0, false)).toBeNull();
});

test('groups listener addresses and connections into one row per port and PID', () => {
  const sockets = [
    port(8004),
    { ...port(8004), local_address: '::1' },
    { ...port(8004), state: 'ESTABLISHED', remote_address: '127.0.0.1:50001' },
    { ...port(8004), state: 'ESTABLISHED', remote_address: '127.0.0.1:50002' },
    { ...port(8004), protocol: 'UDP', state: 'BOUND' },
    port(8004, 99),
  ];
  const rows = buildPortRows(sockets, [owner], 'port');
  expect(rows).toHaveLength(2);
  const row = rows.find((row) => row.port.pid === 42)!;
  expect(row.sockets).toHaveLength(5);
  expect(row.connectionCount).toBe(2);
  expect(row.port.state).toBe('LISTEN');
  expect(row.port.protocol).toBe('TCP, UDP');
  expect(row.port.local_address).toBe('127.0.0.1, ::1');
  expect(row.port.remote_address).toBeNull();
  expect(sockets[0].protocol).toBe('TCP');
  expect(buildPortRows([...sockets].reverse(), [owner], 'port')).toEqual(rows);
});

test('remote filtering keeps the owning group and all its connection details', () => {
  const sockets = [
    port(8004),
    { ...port(8004), state: 'ESTABLISHED', remote_address: '127.0.0.1:50001' },
    { ...port(8004), state: 'ESTABLISHED', remote_address: '127.0.0.1:50002' },
    port(9000),
  ];
  const rows = buildPortRows(sockets, [owner], 'port', '50002');
  expect(rows).toHaveLength(1);
  expect(rows[0].port.local_port).toBe(8004);
  expect(rows[0].sockets).toHaveLength(3);
  expect(rows[0].connectionCount).toBe(2);
});

test('focus stays with the port group when individual remote connections change', () => {
  const before = buildPortRows([port(8004)], [owner], 'port')[0];
  const after = buildPortRows(
    [{ ...port(8004), state: 'ESTABLISHED', remote_address: '[::1]:50003' }],
    [owner],
    'port',
  );
  expect(resolveFocusedPort(after, before.key, 42, 0, false)?.key).toBe(before.key);
});

test('listener sorting keeps UDP and connections visible and sorts each category numerically', () => {
  const sockets = [
    { ...port(50), state: 'ESTABLISHED', remote_address: '127.0.0.1:443' },
    { ...port(53), protocol: 'UDP', state: 'BOUND' },
    port(8004),
    port(443),
    { ...port(8004), state: 'ESTABLISHED', remote_address: '127.0.0.1:50001' },
  ];
  const rows = buildPortRows(sockets, [owner], 'listeners');
  expect(rows.map((row) => row.port.local_port)).toEqual([443, 8004, 50, 53]);
  expect(rows[1].sockets).toHaveLength(2);
  expect(buildPortRows(sockets, [owner], 'port').map((row) => row.port.local_port)).toEqual([50, 53, 443, 8004]);
  const selected = rows[1];
  const refreshed = buildPortRows([...sockets, port(80)], [owner], 'listeners');
  expect(resolveFocusedPort(refreshed, selected.key, owner.pid, 1, false)?.key).toBe(selected.key);
  expect(buildPortRows(sockets, [owner], 'listeners', '50001')[0]?.key).toBe(selected.key);
});

test('unknown owners group by endpoints and protocol, with stable identity across state changes', () => {
  const listener = port(8004, null);
  const connection = { ...listener, state: 'ESTABLISHED', remote_address: '127.0.0.1:50001' };
  const sockets = [
    listener,
    { ...listener, local_address: '::1' },
    { ...listener, protocol: 'UDP', state: 'BOUND' },
    connection,
    { ...connection, remote_address: '127.0.0.1:50002' },
  ];
  const rows = buildPortRows(sockets, [], 'listeners');
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map((row) => row.key)).size).toBe(5);
  expect(rows.every((row) => row.process === null && row.sockets.length === 1)).toBe(true);
  const changed = { ...connection, state: 'CLOSE_WAIT' };
  expect(portKey(changed)).toBe(portKey(connection));
  const refreshed = buildPortRows([changed, listener], [], 'listeners');
  expect(resolveFocusedPort(refreshed, portKey(connection), null, 0, false)?.key).toBe(portKey(connection));
  const filtered = buildPortRows(sockets, [], 'listeners', '50002');
  expect(filtered).toHaveLength(1);
  expect(filtered[0].sockets[0].remote_address).toBe('127.0.0.1:50002');
  expect(buildPortRows([...sockets].reverse(), [], 'listeners')).toEqual(rows);
});

test('expanded unknown endpoints survive state changes and disappear independently', () => {
  const store = useProcessStore.getState();
  store.reset();
  try {
    expect(useProcessStore.getState().portSortMode).toBe('listeners');
    const first = port(8004, null);
    const second = { ...first, local_address: '::1' };
    const snapshot = {
      type: 'snapshot' as const,
      processes: [],
      ports: [first, second],
      ports_error: null,
      cpu_count: 1,
      mem_used: 0,
      mem_total: 0,
      load_average: [0, 0, 0] as [number, number, number],
    };
    store.setSnapshot(snapshot);
    store.togglePortExpanded(portKey(first));
    store.togglePortExpanded(portKey(second));
    store.setSnapshot({ ...snapshot, ports: [{ ...second, state: 'CLOSED' }] });
    expect([...useProcessStore.getState().expandedPorts]).toEqual([portKey(second)]);
    store.setSnapshot({ ...snapshot, ports: [] });
    expect(useProcessStore.getState().expandedPorts.size).toBe(0);
  } finally {
    store.reset();
  }
});
