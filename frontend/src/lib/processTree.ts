import type { ProcessInfo } from '../protocol/process-messages';

export interface ProcessTreeRow {
  process: ProcessInfo;
  depth: number;
  hasChildren: boolean;
}

export const PROCESS_SORT_MODES = [
  'cpu',
  'memory-percent',
  'time',
  'pid',
  'user',
  'resident-memory',
  'virtual-memory',
] as const;

export type ProcessSortMode = (typeof PROCESS_SORT_MODES)[number];

export const PROCESS_SORT_LABELS: Record<ProcessSortMode, string> = {
  cpu: 'CPU%',
  'memory-percent': 'MEM%',
  time: 'time',
  pid: 'PID',
  user: 'user',
  'resident-memory': 'resident mem',
  'virtual-memory': 'virtual mem',
};

export function isProcessSortDescending(mode: ProcessSortMode): boolean {
  return mode !== 'pid' && mode !== 'user';
}

export function nextProcessSortMode(mode: ProcessSortMode): ProcessSortMode {
  const index = PROCESS_SORT_MODES.indexOf(mode);
  return PROCESS_SORT_MODES[(index + 1) % PROCESS_SORT_MODES.length];
}

function compareNumbers(a: number, b: number, descending: boolean): number {
  return descending ? b - a : a - b;
}

function compareUsers(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareProcesses(a: ProcessInfo, b: ProcessInfo, sortMode: ProcessSortMode): number {
  const comparison = (() => {
    switch (sortMode) {
      case 'cpu':
        return compareNumbers(a.cpu, b.cpu, true);
      case 'memory-percent':
      case 'resident-memory':
        return compareNumbers(a.memory, b.memory, true);
      case 'time':
        return compareNumbers(a.run_time, b.run_time, true);
      case 'user':
        return compareUsers(a.user, b.user);
      case 'virtual-memory':
        return compareNumbers(a.virtual_memory, b.virtual_memory, true);
      case 'pid':
        return compareNumbers(a.pid, b.pid, false);
    }
  })();

  return comparison || a.pid - b.pid;
}

export function sortProcesses(processes: ProcessInfo[], sortMode: ProcessSortMode): ProcessInfo[] {
  return [...processes].sort((a, b) => compareProcesses(a, b, sortMode));
}

/** Flatten the process list for the default, non-hierarchical view. */
export function flattenProcessList(processes: ProcessInfo[], sortMode: ProcessSortMode): ProcessTreeRow[] {
  return sortProcesses(processes, sortMode).map((process) => ({ process, depth: 0, hasChildren: false }));
}

/** Flatten the process hierarchy in display order, omitting folded descendants. */
export function flattenProcessTree(
  processes: ProcessInfo[],
  collapsedPids: Set<number>,
  sortMode: ProcessSortMode = 'pid',
): ProcessTreeRow[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const children = new Map<number, ProcessInfo[]>();
  const roots: ProcessInfo[] = [];

  for (const process of processes) {
    const parentPid = process.parent_pid;
    if (parentPid !== null && parentPid !== process.pid && byPid.has(parentPid)) {
      const siblings = children.get(parentPid) ?? [];
      siblings.push(process);
      children.set(parentPid, siblings);
    } else {
      roots.push(process);
    }
  }

  for (const siblings of children.values()) siblings.sort((a, b) => compareProcesses(a, b, sortMode));
  roots.sort((a, b) => compareProcesses(a, b, sortMode));

  const rows: ProcessTreeRow[] = [];
  const visited = new Set<number>();
  const visit = (process: ProcessInfo, depth: number) => {
    if (visited.has(process.pid)) return;
    visited.add(process.pid);
    const descendants = children.get(process.pid) ?? [];
    rows.push({ process, depth, hasChildren: descendants.length > 0 });
    if (!collapsedPids.has(process.pid)) {
      for (const child of descendants) visit(child, depth + 1);
    } else {
      const hide = (child: ProcessInfo) => {
        if (visited.has(child.pid)) return;
        visited.add(child.pid);
        for (const descendant of children.get(child.pid) ?? []) hide(descendant);
      };
      for (const child of descendants) hide(child);
    }
  };

  for (const root of roots) visit(root, 0);
  // A malformed or racing parent relationship should not make a process
  // disappear from the viewer.
  for (const process of [...processes].sort((a, b) => compareProcesses(a, b, sortMode))) visit(process, 0);

  return rows;
}

/** Build rows for either the flat process list or the opt-in tree view. */
export function buildProcessRows(
  processes: ProcessInfo[],
  collapsedPids: Set<number>,
  sortMode: ProcessSortMode,
  treeMode: boolean,
): ProcessTreeRow[] {
  return treeMode ? flattenProcessTree(processes, collapsedPids, sortMode) : flattenProcessList(processes, sortMode);
}

/** Keep matching rows visible while filtering the flattened process tree. */
export function filterProcessTreeRows(rows: ProcessTreeRow[], query: string): ProcessTreeRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return rows;

  return rows.filter(({ process }) =>
    [String(process.pid), process.name, process.command, process.status, process.user ?? ''].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}
