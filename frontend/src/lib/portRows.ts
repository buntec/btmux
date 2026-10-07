import type { PortInfo, ProcessInfo } from '../protocol/process-messages';

export const PORT_SORT_MODES = ['listeners', 'port', 'protocol', 'address', 'state', 'pid', 'command'] as const;
export type PortSortMode = (typeof PORT_SORT_MODES)[number];
export const PORT_SORT_LABELS: Record<PortSortMode, string> = {
  listeners: 'listeners first',
  port: 'port',
  protocol: 'protocol',
  address: 'address',
  state: 'state',
  pid: 'PID',
  command: 'process',
};

export interface PortRow {
  key: string;
  port: PortInfo;
  process: ProcessInfo | null;
  sockets: PortInfo[];
  connectionCount: number;
}

export function portKey(port: PortInfo): string {
  if (port.pid === null) {
    return JSON.stringify([port.local_port, null, port.protocol, port.local_address, port.remote_address]);
  }
  return JSON.stringify([port.local_port, port.pid]);
}

function socketMatches(port: PortInfo, process: ProcessInfo | null, query: string): boolean {
  return [
    String(port.local_port),
    port.protocol,
    port.local_address,
    port.remote_address ?? '',
    port.state,
    port.pid === null ? '' : String(port.pid),
    process?.name ?? '',
    process?.command ?? '',
    process?.user ?? '',
  ].some((value) => value.toLowerCase().includes(query));
}

export function buildPortRows(
  ports: PortInfo[],
  processes: ProcessInfo[],
  sortMode: PortSortMode,
  query = '',
): PortRow[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const groups = new Map<string, PortRow>();
  for (const port of ports) {
    const key = portKey(port);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        port,
        process: port.pid === null ? null : (byPid.get(port.pid) ?? null),
        sockets: [],
        connectionCount: 0,
      };
      groups.set(key, group);
    }
    group.sockets.push(port);
    if (port.remote_address !== null) group.connectionCount++;
  }
  const normalized = query.trim().toLowerCase();
  const rows = [...groups.values()].filter(
    (group) => !normalized || group.sockets.some((socket) => socketMatches(socket, group.process, normalized)),
  );
  for (const group of rows) {
    group.sockets.sort(
      (a, b) =>
        Number(a.remote_address !== null) - Number(b.remote_address !== null) ||
        a.protocol.localeCompare(b.protocol) ||
        a.local_address.localeCompare(b.local_address) ||
        (a.remote_address ?? '').localeCompare(b.remote_address ?? ''),
    );
    const unique = (values: string[]) => [...new Set(values)].sort().join(', ');
    group.port = {
      ...group.port,
      protocol: unique(group.sockets.map((socket) => socket.protocol)),
      local_address: unique(group.sockets.map((socket) => socket.local_address)),
      remote_address: null,
      state: group.sockets.some((socket) => socket.state === 'LISTEN')
        ? 'LISTEN'
        : unique(group.sockets.map((socket) => socket.state)),
    };
  }
  return rows.sort((a, b) => {
    const comparison = (() => {
      switch (sortMode) {
        case 'listeners':
          return Number(b.sockets.some(isListener)) - Number(a.sockets.some(isListener));
        case 'port':
          return a.port.local_port - b.port.local_port;
        case 'protocol':
          return a.port.protocol.localeCompare(b.port.protocol);
        case 'address':
          return a.port.local_address.localeCompare(b.port.local_address);
        case 'state':
          return a.port.state.localeCompare(b.port.state);
        case 'pid':
          return (a.port.pid ?? Infinity) - (b.port.pid ?? Infinity);
        case 'command':
          return (a.process?.name ?? '').localeCompare(b.process?.name ?? '');
      }
    })();
    return comparison || a.port.local_port - b.port.local_port || a.key.localeCompare(b.key);
  });
}

function isListener(socket: PortInfo): boolean {
  return socket.protocol === 'TCP' && socket.state === 'LISTEN';
}

export function resolveFocusedPort(
  rows: PortRow[],
  key: string | null,
  pid: number | null,
  index: number,
  keepRow: boolean,
): PortRow | null {
  if (!keepRow) {
    const existing = rows.find((row) => row.key === key);
    if (existing) return existing;
    if (key === null) {
      const owner = rows.find((row) => row.port.pid === pid);
      if (owner) return owner;
    }
  }
  return rows[Math.min(index, rows.length - 1)] ?? null;
}
