import { create } from 'zustand';
import type { ProcessInfo, ProcessKillResult, ProcessSnapshot } from '../protocol/process-messages';
import { nextProcessSortMode, type ProcessSortMode } from '../lib/processTree';

interface ProcessStore {
  snapshot: ProcessSnapshot | null;
  processes: ProcessInfo[];
  focusedPid: number | null;
  collapsedPids: Set<number>;
  sortMode: ProcessSortMode;
  treeMode: boolean;
  filterQuery: string;
  filterActive: boolean;
  message: ProcessKillResult | { type: 'error'; message: string } | null;
  setSnapshot: (snapshot: ProcessSnapshot) => void;
  setFocusedPid: (pid: number | null) => void;
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
  collapsedPids: new Set(),
  sortMode: 'cpu',
  treeMode: false,
  filterQuery: '',
  filterActive: false,
  message: null,
  setSnapshot: (snapshot) =>
    set((state) => {
      const pids = new Set(snapshot.processes.map((process) => process.pid));
      const collapsedPids = new Set([...state.collapsedPids].filter((pid) => pids.has(pid)));
      const previousFocusedPid = state.focusedPid;
      let focusedPid = previousFocusedPid;
      if (previousFocusedPid !== null && !pids.has(previousFocusedPid)) {
        const ordered = [...snapshot.processes].sort((a, b) => a.pid - b.pid);
        focusedPid =
          ordered.find((process) => process.pid >= previousFocusedPid)?.pid ?? ordered[ordered.length - 1]?.pid ?? null;
      }
      return {
        snapshot,
        processes: snapshot.processes,
        focusedPid,
        collapsedPids,
      };
    }),
  setFocusedPid: (pid) => set({ focusedPid: pid }),
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
  setMessage: (message) => set({ message }),
  reset: () =>
    set({
      snapshot: null,
      processes: [],
      focusedPid: null,
      collapsedPids: new Set(),
      sortMode: 'cpu',
      treeMode: false,
      filterQuery: '',
      filterActive: false,
      message: null,
    }),
}));
