import { create } from 'zustand';
import type {
  FileEntry,
  FileContent,
  FileSearchResult,
  SearchResult,
  GitStatusResult,
  FileDiff,
} from '../protocol/file-messages';

export type SearchMode = 'off' | 'files' | 'content';

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

  searchMode: SearchMode;
  searchQuery: string;
  searchResults: FileSearchResult[];
  contentSearchResults: SearchResult[];

  isGitMode: boolean;
  gitStatus: GitStatusResult | null;
  gitDiff: FileDiff | null;
  gitFocusedIndex: number;
  gitExpandedSections: Set<string>;

  setCurrentPath: (path: string) => void;
  setEntries: (entries: FileEntry[]) => void;
  setSelectedFile: (path: string | null) => void;
  setFileContent: (content: FileContent | null) => void;
  setIsLoading: (loading: boolean) => void;
  setFocusedIndex: (index: number) => void;
  setFilterQuery: (query: string) => void;
  setIsFilterActive: (active: boolean) => void;
  setShowDotFiles: (show: boolean) => void;
  setSearchMode: (mode: SearchMode) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: FileSearchResult[]) => void;
  setContentSearchResults: (results: SearchResult[]) => void;
  setIsGitMode: (mode: boolean) => void;
  setGitStatus: (status: GitStatusResult | null) => void;
  setGitDiff: (diff: FileDiff | null) => void;
  setGitFocusedIndex: (index: number) => void;
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
  searchMode: 'off',
  searchQuery: '',
  searchResults: [],
  contentSearchResults: [],
  isGitMode: false,
  gitStatus: null,
  gitDiff: null,
  gitFocusedIndex: 0,
  gitExpandedSections: new Set(['staged', 'unstaged', 'untracked']),

  setCurrentPath: (path) => set({ currentPath: path }),
  setEntries: (entries) => set({ entries, focusedIndex: 0 }),
  setSelectedFile: (path) => set({ selectedFile: path }),
  setFileContent: (content) => set({ fileContent: content }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setFocusedIndex: (index) => set({ focusedIndex: index }),
  setFilterQuery: (query) => set({ filterQuery: query }),
  setIsFilterActive: (active) => set({ isFilterActive: active, filterQuery: active ? get().filterQuery : '' }),
  setShowDotFiles: (show) => set({ showDotFiles: show }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),
  setContentSearchResults: (results) => set({ contentSearchResults: results }),
  setIsGitMode: (mode) => set({ isGitMode: mode }),
  setGitStatus: (status) => set({ gitStatus: status }),
  setGitDiff: (diff) => set({ gitDiff: diff }),
  setGitFocusedIndex: (index) => set({ gitFocusedIndex: index }),
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
      searchMode: 'off',
      searchQuery: '',
      searchResults: [],
      contentSearchResults: [],
      isGitMode: false,
      gitStatus: null,
      gitDiff: null,
      gitFocusedIndex: 0,
    }),
}));
