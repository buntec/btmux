import type { PortInfo, ProcessInfo } from '../protocol/process-messages';
import type { SessionState } from '../state/types';

export interface Usage {
  cpu: number;
  memory: number;
  diskRead: number;
  diskWrite: number;
  processes: number;
  ports: number;
}

export interface UsageRow {
  key: string;
  kind: 'session' | 'window' | 'pane' | 'port';
  depth: number;
  label: string;
  /** Hover text; a pane's working directory. */
  title?: string;
  /** Port rows have none. */
  usage: Usage | null;
  /** The panes this row sums; none for a port row. */
  panes: string[];
  /** A port's owning processes, or why usage is incomplete. */
  detail?: string;
  hasChildren: boolean;
}

interface PanePort {
  protocol: string;
  address: string;
  port: number;
  names: Set<string>;
}

/** The lowest default client port: Linux's; macOS and Windows start higher. */
const EPHEMERAL_PORTS_START = 32768;

const UNCOUNTED = "Git Bash and WSL programs aren't the shell's Windows children, so they aren't counted";

const emptyUsage = (): Usage => ({ cpu: 0, memory: 0, diskRead: 0, diskWrite: 0, processes: 0, ports: 0 });

function addUsage(total: Usage, usage: Usage) {
  total.cpu += usage.cpu;
  total.memory += usage.memory;
  total.diskRead += usage.diskRead;
  total.diskWrite += usage.diskWrite;
  total.processes += usage.processes;
  total.ports += usage.ports;
}

function portLabel({ protocol, address, port }: PanePort): string {
  return `${protocol} ${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/** Listening sockets per pane, one per address however many processes share it. */
function panePorts(ports: PortInfo[], processes: ProcessInfo[]): Map<string, PanePort[]> {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const groups = new Map<string, Map<string, PanePort>>();
  for (const socket of ports) {
    if (socket.protocol === 'TCP' && socket.state !== 'LISTEN') continue;
    // Client sockets (DNS, QUIC) are bound too, and come and go.
    if (socket.protocol === 'UDP' && socket.local_port >= EPHEMERAL_PORTS_START) continue;
    const process = socket.pid === null ? undefined : byPid.get(socket.pid);
    if (!process?.pane_id) continue;
    const pane = groups.get(process.pane_id) ?? new Map<string, PanePort>();
    groups.set(process.pane_id, pane);
    const key = `${socket.protocol} ${socket.local_address} ${socket.local_port}`;
    const port = pane.get(key) ?? {
      protocol: socket.protocol,
      address: socket.local_address,
      port: socket.local_port,
      names: new Set<string>(),
    };
    pane.set(key, port);
    if (process.name) port.names.add(process.name);
  }
  return new Map(
    [...groups].map(([pane, sockets]) => [
      pane,
      [...sockets.values()].sort(
        (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address),
      ),
    ]),
  );
}

/** Sessions start folded; `toggles` holds rows folded differently from that. */
export function isUsageFolded(key: string, toggles: Set<string>): boolean {
  return key.startsWith('session:') !== toggles.has(key);
}

/** Session, window, and pane rows with summed usage, omitting folded children. */
export function buildUsageRows(
  sessions: SessionState[],
  processes: ProcessInfo[],
  ports: PortInfo[],
  toggles: Set<string>,
  uncountedPanes: string[] = [],
): UsageRow[] {
  const uncounted = new Set(uncountedPanes);
  const markPartial = (row: UsageRow) => {
    row.detail = 'partial';
    row.title = UNCOUNTED;
  };
  const byPane = new Map<string, Usage>();
  for (const process of processes) {
    if (!process.pane_id) continue;
    const usage = byPane.get(process.pane_id) ?? emptyUsage();
    byPane.set(process.pane_id, usage);
    addUsage(usage, {
      cpu: process.cpu,
      memory: process.memory,
      diskRead: process.disk_read,
      diskWrite: process.disk_write,
      processes: 1,
      ports: 0,
    });
  }
  const socketsByPane = panePorts(ports, processes);

  const rows: UsageRow[] = [];
  for (const session of sessions) {
    const sessionUsage = emptyUsage();
    const sessionKey = `session:${session.id}`;
    const sessionRow: UsageRow = {
      key: sessionKey,
      kind: 'session',
      depth: 0,
      label: session.name,
      usage: sessionUsage,
      panes: session.windows.flatMap((window) => window.panes.map((pane) => pane.id)),
      hasChildren: session.windows.length > 0,
    };
    rows.push(sessionRow);
    for (const window of session.windows) {
      const windowUsage = emptyUsage();
      const windowKey = `window:${window.id}`;
      const windowRow: UsageRow = {
        key: windowKey,
        kind: 'window',
        depth: 1,
        label: window.name,
        usage: windowUsage,
        panes: window.panes.map((pane) => pane.id),
        hasChildren: window.panes.length > 0,
      };
      if (window.panes.some((pane) => uncounted.has(pane.id))) {
        markPartial(windowRow);
        markPartial(sessionRow);
      }
      const windowRows = [windowRow];
      window.panes.forEach((pane, index) => {
        const sockets = socketsByPane.get(pane.id) ?? [];
        const usage = { ...(byPane.get(pane.id) ?? emptyUsage()), ports: sockets.length };
        const paneKey = `pane:${pane.id}`;
        addUsage(windowUsage, usage);
        windowRows.push({
          key: paneKey,
          kind: 'pane',
          depth: 2,
          label: pane.title || `pane ${index + 1}`,
          title: uncounted.has(pane.id) ? [pane.cwd, UNCOUNTED].filter(Boolean).join('\n') : (pane.cwd ?? undefined),
          detail: uncounted.has(pane.id) ? 'not counted' : undefined,
          usage,
          panes: [pane.id],
          hasChildren: sockets.length > 0,
        });
        if (isUsageFolded(paneKey, toggles)) return;
        for (const socket of sockets) {
          windowRows.push({
            key: `port:${pane.id}:${portLabel(socket)}`,
            kind: 'port',
            depth: 3,
            label: portLabel(socket),
            usage: null,
            panes: [],
            detail: [...socket.names].sort().join(', '),
            hasChildren: false,
          });
        }
      });
      addUsage(sessionUsage, windowUsage);
      if (isUsageFolded(sessionKey, toggles)) continue;
      rows.push(...(isUsageFolded(windowKey, toggles) ? windowRows.slice(0, 1) : windowRows));
    }
  }
  return rows;
}

/** The nearest row above `index` that is one level up. */
export function usageParentIndex(rows: UsageRow[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].depth < rows[index].depth) return i;
  }
  return -1;
}

/** The pane row of a port row's key, `port:<pane id>:<socket>`. */
export function usagePortPane(key: string | null): string | null {
  return key?.startsWith('port:') ? `pane:${key.split(':')[1]}` : null;
}

/** What selecting a row restricts the process list to; a port row means its pane. */
export function usageScope(rows: UsageRow[], key: string | null): { label: string; panes: Set<string> } | null {
  const index = rows.findIndex((row) => row.key === key);
  const row = rows[index]?.kind === 'port' ? rows[usageParentIndex(rows, index)] : rows[index];
  return row ? { label: `${row.kind}: ${row.label}`, panes: new Set(row.panes) } : null;
}
