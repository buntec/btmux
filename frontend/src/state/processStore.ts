import { create } from 'zustand';
import type { ProcessInfo, ProcessKillResult, ProcessSnapshot } from '../protocol/process-messages';
import { portKey, PORT_SORT_MODES, type PortSortMode } from '../lib/portRows';
import { nextProcessSortMode, type ProcessSortMode } from '../lib/processTree';

const MESSAGE_TIMEOUT_MS = 4000;

let messageTimer: ReturnType<typeof setTimeout> | null = null;

function clearMessageTimer() {
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = null;
}

interface ProcessStore {
  snapshot: ProcessSnapshot | null;
  processes: ProcessInfo[];
  focusedPid: number | null;
  viewMode: 'processes' | 'ports';
  focusedPort: string | null;
  portSortMode: PortSortMode;
  portSortReversed: boolean;
  expandedPorts: Set<string>;
  togglePortExpanded: (key: string) => void;
  toggleViewMode: () => void;
  setFocusedPort: (key: string | null, pid: number | null) => void;
  setPortSortMode: (mode: PortSortMode) => void;
  /** Header click: select the column, or flip direction if already active. */
  sortPortsBy: (mode: PortSortMode) => void;
  cyclePortSortMode: () => void;
  followFocus: boolean;
  collapsedPids: Set<number>;
  sortMode: ProcessSortMode;
  sortReversed: boolean;
  treeMode: boolean;
  filterQuery: string;
  filterActive: boolean;
  message: ProcessKillResult | { type: 'error'; message: string } | null;
  setSnapshot: (snapshot: ProcessSnapshot) => void;
  setFocusedPid: (pid: number | null) => void;
  toggleFollowFocus: () => void;
  toggleCollapsed: (pid: number) => void;
  setSortMode: (sortMode: ProcessSortMode) => void;
  sortBy: (sortMode: ProcessSortMode) => void;
  cycleSortMode: () => void;
  toggleTreeMode: () => void;
  setFilterQuery: (query: string) => void;
  setFilterActive: (active: boolean) => void;
  setMessage: (message: ProcessStore['message']) => void;
  reset: () => void;
}

export const useProcessStore = create<ProcessStore>((set, get) => ({
  snapshot: null,
  processes: [],
  focusedPid: null,
  viewMode: 'processes',
  focusedPort: null,
  portSortMode: 'listeners',
  portSortReversed: false,
  expandedPorts: new Set(),
  followFocus: false,
  collapsedPids: new Set(),
  sortMode: 'cpu',
  sortReversed: false,
  treeMode: false,
  filterQuery: '',
  filterActive: false,
  message: null,
  // Tables repair focus in displayed row order.
  setSnapshot: (snapshot) =>
    set((state) => {
      const pids = new Set(snapshot.processes.map((process) => process.pid));
      const collapsedPids = new Set([...state.collapsedPids].filter((pid) => pids.has(pid)));
      const portKeys = snapshot.ports ? new Set(snapshot.ports.map(portKey)) : null;
      const expandedPorts = portKeys
        ? new Set([...state.expandedPorts].filter((key) => portKeys.has(key)))
        : state.expandedPorts;
      return { snapshot, processes: snapshot.processes, collapsedPids, expandedPorts };
    }),
  setFocusedPid: (pid) => set({ focusedPid: pid }),
  toggleViewMode: () => set((state) => ({ viewMode: state.viewMode === 'processes' ? 'ports' : 'processes' })),
  setFocusedPort: (focusedPort, focusedPid) => set({ focusedPort, focusedPid }),
  togglePortExpanded: (key) =>
    set((state) => {
      const expandedPorts = new Set(state.expandedPorts);
      if (expandedPorts.has(key)) expandedPorts.delete(key);
      else expandedPorts.add(key);
      return { expandedPorts };
    }),
  setPortSortMode: (portSortMode) => set({ portSortMode, portSortReversed: false }),
  sortPortsBy: (mode) =>
    set((state) =>
      state.portSortMode === mode
        ? { portSortReversed: !state.portSortReversed }
        : { portSortMode: mode, portSortReversed: false },
    ),
  cyclePortSortMode: () =>
    set((state) => ({
      portSortMode: PORT_SORT_MODES[(PORT_SORT_MODES.indexOf(state.portSortMode) + 1) % PORT_SORT_MODES.length],
      portSortReversed: false,
    })),
  toggleFollowFocus: () => set((state) => ({ followFocus: !state.followFocus })),
  toggleCollapsed: (pid) => {
    const collapsedPids = new Set(get().collapsedPids);
    if (collapsedPids.has(pid)) collapsedPids.delete(pid);
    else collapsedPids.add(pid);
    set({ collapsedPids });
  },
  setSortMode: (sortMode) => set({ sortMode, sortReversed: false }),
  sortBy: (mode) =>
    set((state) =>
      state.sortMode === mode ? { sortReversed: !state.sortReversed } : { sortMode: mode, sortReversed: false },
    ),
  cycleSortMode: () => set((state) => ({ sortMode: nextProcessSortMode(state.sortMode), sortReversed: false })),
  toggleTreeMode: () => set((state) => ({ treeMode: !state.treeMode })),
  setFilterQuery: (filterQuery) => set({ filterQuery }),
  setFilterActive: (filterActive) => set({ filterActive, filterQuery: filterActive ? get().filterQuery : '' }),
  setMessage: (message) => {
    clearMessageTimer();
    set({ message });
    if (message) messageTimer = setTimeout(() => set({ message: null }), MESSAGE_TIMEOUT_MS);
  },
  reset: () => {
    clearMessageTimer();
    set({
      snapshot: null,
      processes: [],
      focusedPid: null,
      viewMode: 'processes',
      focusedPort: null,
      portSortMode: 'listeners',
      portSortReversed: false,
      expandedPorts: new Set(),
      followFocus: false,
      collapsedPids: new Set(),
      sortMode: 'cpu',
      sortReversed: false,
      treeMode: false,
      filterQuery: '',
      filterActive: false,
      message: null,
    });
  },
}));
