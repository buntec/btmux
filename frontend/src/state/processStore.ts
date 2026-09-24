import { create } from 'zustand';
import type { ProcessInfo, ProcessKillResult, ProcessSnapshot } from '../protocol/process-messages';
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
  followFocus: boolean;
  collapsedPids: Set<number>;
  sortMode: ProcessSortMode;
  treeMode: boolean;
  filterQuery: string;
  filterActive: boolean;
  message: ProcessKillResult | { type: 'error'; message: string } | null;
  setSnapshot: (snapshot: ProcessSnapshot) => void;
  setFocusedPid: (pid: number | null) => void;
  toggleFollowFocus: () => void;
  toggleCollapsed: (pid: number) => void;
  setSortMode: (sortMode: ProcessSortMode) => void;
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
  followFocus: false,
  collapsedPids: new Set(),
  sortMode: 'cpu',
  treeMode: false,
  filterQuery: '',
  filterActive: false,
  message: null,
  // Focus repair happens in ProcessTree, which knows the displayed row order.
  setSnapshot: (snapshot) =>
    set((state) => {
      const pids = new Set(snapshot.processes.map((process) => process.pid));
      const collapsedPids = new Set([...state.collapsedPids].filter((pid) => pids.has(pid)));
      return { snapshot, processes: snapshot.processes, collapsedPids };
    }),
  setFocusedPid: (pid) => set({ focusedPid: pid }),
  toggleFollowFocus: () => set((state) => ({ followFocus: !state.followFocus })),
  toggleCollapsed: (pid) => {
    const collapsedPids = new Set(get().collapsedPids);
    if (collapsedPids.has(pid)) collapsedPids.delete(pid);
    else collapsedPids.add(pid);
    set({ collapsedPids });
  },
  setSortMode: (sortMode) => set({ sortMode }),
  cycleSortMode: () => set((state) => ({ sortMode: nextProcessSortMode(state.sortMode) })),
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
      followFocus: false,
      collapsedPids: new Set(),
      sortMode: 'cpu',
      treeMode: false,
      filterQuery: '',
      filterActive: false,
      message: null,
    });
  },
}));
