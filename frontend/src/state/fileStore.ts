import { create } from 'zustand';
import type {
  FileEntry,
  FileContent,
  FileSearchResult,
  SearchResult,
  GitStatusResult,
  GitLogResult,
  GitCommitDiffResult,
  FileDiff,
  TreeNode,
} from '../protocol/file-messages';

export type SearchMode = 'off' | 'files' | 'content';
export type GitView = 'status' | 'log';

export interface YankRegister {
  paths: string[];
  mode: 'copy' | 'cut';
}

interface FileStore {
  currentPath: string;
  entries: FileEntry[];
  selectedFile: string | null;
  fileContent: FileContent | null;
  isLoading: boolean;
  focusedIndex: number;
  filterQuery: string;
  isFilterActive: boolean;
  showDotFiles: boolean;
  showIgnored: boolean;

  // Multi-select
  selectedPaths: Set<string>;
  yankRegister: YankRegister | null;

  // Inline rename
  pendingRename: { path: string; name: string } | null;

  searchMode: SearchMode;
  searchQuery: string;
  searchResults: FileSearchResult[];
  contentSearchResults: SearchResult[];

  directoryTree: TreeNode | null;
  selectedDirectory: string | null;
  treeDepth: number;

  isGitMode: boolean;
  gitView: GitView;
  gitStatus: GitStatusResult | null;
  gitLog: GitLogResult | null;
  gitDiff: FileDiff | null;
  gitCommitDiff: GitCommitDiffResult | null;
  gitFocusedIndex: number;
  gitLogFocusedIndex: number;
  gitExpandedSections: Set<string>;

  setDirectoryTree: (tree: TreeNode | null) => void;
  setSelectedDirectory: (path: string | null) => void;
  setTreeDepth: (depth: number) => void;
  setCurrentPath: (path: string) => void;
  setEntries: (entries: FileEntry[]) => void;
  setSelectedFile: (path: string | null) => void;
  setFileContent: (content: FileContent | null) => void;
  setIsLoading: (loading: boolean) => void;
  setFocusedIndex: (index: number) => void;
  setFilterQuery: (query: string) => void;
  setIsFilterActive: (active: boolean) => void;
  setShowDotFiles: (show: boolean) => void;
  setShowIgnored: (show: boolean) => void;
  toggleSelectedPath: (path: string) => void;
  clearSelection: () => void;
  setYankRegister: (register: YankRegister | null) => void;
  setPendingRename: (rename: { path: string; name: string } | null) => void;
  setSearchMode: (mode: SearchMode) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: FileSearchResult[]) => void;
  setContentSearchResults: (results: SearchResult[]) => void;
  setIsGitMode: (mode: boolean) => void;
  setGitView: (view: GitView) => void;
  setGitStatus: (status: GitStatusResult | null) => void;
  setGitLog: (log: GitLogResult | null) => void;
  setGitDiff: (diff: FileDiff | null) => void;
  setGitCommitDiff: (diff: GitCommitDiffResult | null) => void;
  setGitFocusedIndex: (index: number) => void;
  setGitLogFocusedIndex: (index: number) => void;
  toggleGitSection: (section: string) => void;
  reset: () => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  currentPath: '/',
  entries: [],
  selectedFile: null,
  fileContent: null,
  isLoading: false,
  focusedIndex: 0,
  filterQuery: '',
  isFilterActive: false,
  showDotFiles: false,
  showIgnored: false,
  selectedPaths: new Set(),
  yankRegister: null,
  pendingRename: null,
  searchMode: 'off',
  searchQuery: '',
  searchResults: [],
  contentSearchResults: [],
  directoryTree: null,
  selectedDirectory: null,
  treeDepth: 1,

  isGitMode: false,
  gitView: 'status',
  gitStatus: null,
  gitLog: null,
  gitDiff: null,
  gitCommitDiff: null,
  gitFocusedIndex: 0,
  gitLogFocusedIndex: 0,
  gitExpandedSections: new Set(['staged', 'unstaged', 'untracked']),

  setDirectoryTree: (tree) => set({ directoryTree: tree }),
  setSelectedDirectory: (path) => set({ selectedDirectory: path }),
  setTreeDepth: (depth) => set({ treeDepth: depth }),
  setCurrentPath: (path) => set({ currentPath: path }),
  setEntries: (entries) => set({ entries, focusedIndex: 0 }),
  setSelectedFile: (path) => set({ selectedFile: path }),
  setFileContent: (content) => set({ fileContent: content }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setFocusedIndex: (index) => set({ focusedIndex: index }),
  setFilterQuery: (query) => set({ filterQuery: query }),
  setIsFilterActive: (active) => set({ isFilterActive: active, filterQuery: active ? get().filterQuery : '' }),
  setShowDotFiles: (show) => set({ showDotFiles: show }),
  setShowIgnored: (show) => set({ showIgnored: show }),
  toggleSelectedPath: (path) => {
    const s = new Set(get().selectedPaths);
    if (s.has(path)) s.delete(path);
    else s.add(path);
    set({ selectedPaths: s });
  },
  clearSelection: () => set({ selectedPaths: new Set() }),
  setYankRegister: (register) => set({ yankRegister: register }),
  setPendingRename: (rename) => set({ pendingRename: rename }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),
  setContentSearchResults: (results) => set({ contentSearchResults: results }),
  setIsGitMode: (mode) => set({ isGitMode: mode }),
  setGitView: (view) => set({ gitView: view }),
  setGitStatus: (status) => set({ gitStatus: status }),
  setGitLog: (log) =>
    set((state) => ({
      gitLog: log,
      gitLogFocusedIndex: log ? Math.min(state.gitLogFocusedIndex, Math.max(log.commits.length - 1, 0)) : 0,
    })),
  setGitDiff: (diff) => set({ gitDiff: diff }),
  setGitCommitDiff: (diff) => set({ gitCommitDiff: diff }),
  setGitFocusedIndex: (index) => set({ gitFocusedIndex: index }),
  setGitLogFocusedIndex: (index) => set({ gitLogFocusedIndex: index }),
  toggleGitSection: (section) => {
    const sections = new Set(get().gitExpandedSections);
    if (sections.has(section)) sections.delete(section);
    else sections.add(section);
    set({ gitExpandedSections: sections });
  },
  reset: () =>
    set({
      currentPath: '/',
      entries: [],
      selectedFile: null,
      fileContent: null,
      isLoading: false,
      focusedIndex: 0,
      filterQuery: '',
      isFilterActive: false,
      directoryTree: null,
      selectedDirectory: null,
      treeDepth: 1,
      selectedPaths: new Set(),
      yankRegister: null,
      pendingRename: null,
      searchMode: 'off',
      searchQuery: '',
      searchResults: [],
      contentSearchResults: [],
      isGitMode: false,
      gitView: 'status',
      gitStatus: null,
      gitLog: null,
      gitDiff: null,
      gitCommitDiff: null,
      gitFocusedIndex: 0,
      gitLogFocusedIndex: 0,
    }),
}));
