import { useEffect, useCallback, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { X } from 'lucide-react';
import { useFileSocket } from '@/hooks/useFileSocket';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';
import { FileTree } from './files/FileTree';
import { FilePreview } from './files/FilePreview';
import { Breadcrumb } from './files/Breadcrumb';
import { GitModeHeader } from './files/GitModeHeader';
import { GitHistory } from './files/GitHistory';
import { GitCommitDiffPreview } from './files/GitCommitDiffPreview';
import { GitCommitModal } from './files/GitCommitModal';
import { GitStatus, computeGitItems, filterGitItems, ALL_GIT_SECTIONS, type GitItem } from './files/GitStatus';
import { FileSearch } from './files/FileSearch';
import { cn, getParent } from '@/lib/utils';
import { getAnimations, getTerminalFontSize } from '@/state/configDefaults';
import { CONNECTION_STATE_LABEL } from '@/lib/connectionState';
import type {
  FileEntry,
  FileContent,
  GitStatusResult,
  GitLogResult,
  GitCommitDiffResult,
  FileDiff,
  TreeNode,
  FileSearchResult,
  SearchResult,
} from '@/protocol/file-messages';
import type { ClientMessage } from '@/protocol/messages';

const MEDIA_EXTENSIONS = new Set([
  'pdf',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',
  'ogv',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'aac',
  'wma',
]);

const DEFAULT_SIDEBAR_RATIO = 1 / 3;

function scrollFilePreview(direction: 1 | -1) {
  const viewport = document.querySelector<HTMLElement>('.file-preview-scroll [data-preview-viewport]');
  if (viewport) viewport.scrollBy({ top: direction * (viewport.clientHeight / 2) });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The git item list as currently navigable — forces all sections open and applies the filter while filtering. */
function visibleGitItems(
  gitStatus: GitStatusResult,
  expandedSections: Set<string>,
  isFilterActive: boolean,
  filterQuery: string,
): GitItem[] {
  const items = computeGitItems(gitStatus, isFilterActive ? ALL_GIT_SECTIONS : expandedSections);
  return isFilterActive ? filterGitItems(items, filterQuery) : items;
}

interface FileBrowserOverlayProps {
  cwd: string | null;
  sessionId: string;
  paneId: string;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function FileBrowserOverlay({ cwd, sessionId, paneId, send, onClose }: FileBrowserOverlayProps) {
  const { send: fileSend, state: fileConnectionState } = useFileSocket();
  const config = useStore((s) => s.config);
  const fileBrowserInitialMode = useStore((s) => s.fileBrowserInitialMode);
  const fileBrowserFocusFile = useStore((s) => s.fileBrowserFocusFile);
  const fontSize = getTerminalFontSize(config);
  const animations = getAnimations(config);
  const currentPath = useFileStore((s) => s.currentPath);
  const entries = useFileStore((s) => s.entries);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const showDotFiles = useFileStore((s) => s.showDotFiles);
  const showIgnored = useFileStore((s) => s.showIgnored);
  const isGitMode = useFileStore((s) => s.isGitMode);
  const gitView = useFileStore((s) => s.gitView);
  const treeDepth = useFileStore((s) => s.treeDepth);
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitLog = useFileStore((s) => s.gitLog);
  const gitDiff = useFileStore((s) => s.gitDiff);
  const gitFocusedIndex = useFileStore((s) => s.gitFocusedIndex);
  const gitLogFocusedIndex = useFileStore((s) => s.gitLogFocusedIndex);
  const gitExpandedSections = useFileStore((s) => s.gitExpandedSections);
  const searchMode = useFileStore((s) => s.searchMode);
  const searchResults = useFileStore((s) => s.searchResults);
  const contentSearchResults = useFileStore((s) => s.contentSearchResults);
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const yankRegister = useFileStore((s) => s.yankRegister);
  const pendingRename = useFileStore((s) => s.pendingRename);
  const store = useFileStore;
  const initialized = useRef(false);
  const gitPreviewGenRef = useRef(0);
  const gitCommitPreviewGenRef = useRef(0);
  const filePreviewGenRef = useRef(0);
  const [ignoreAllSpace, setIgnoreAllSpace] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ paths: string[]; names: string[]; permanent: boolean } | null>(
    null,
  );
  const [pendingDiscard, setPendingDiscard] = useState<{ path: string; untracked: boolean } | null>(null);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { sidebarRatio, onDividerMouseDown } = useSidebarResize(rootRef, DEFAULT_SIDEBAR_RATIO);

  const handleCommitModalOpenChange = useCallback((open: boolean) => {
    setCommitModalOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => rootRef.current?.focus());
    }
  }, []);

  const navigate = useCallback(
    async (path: string, focusTarget?: string) => {
      // Invalidate any file preview request from the directory we are leaving.
      filePreviewGenRef.current += 1;
      store.getState().setIsLoading(true);
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      store.getState().setDirectoryTree(null);
      store.getState().setSelectedDirectory(null);
      store.getState().setTreeDepth(1);
      try {
        const resp = await fileSend('list_dir', { root: path, path: '.' });
        const payload = resp.payload as { path: string; entries: FileEntry[] };
        store.getState().setCurrentPath(payload.path);
        store.getState().setEntries(payload.entries);
        if (focusTarget) {
          const target = payload.entries.find((e) => e.name === focusTarget);
          if (target?.name.startsWith('.')) store.getState().setShowDotFiles(true);
          if (target?.is_ignored) store.getState().setShowIgnored(true);
          const { showDotFiles, showIgnored } = store.getState();
          const visible = payload.entries.filter(
            (e) => (showDotFiles || !e.name.startsWith('.')) && (showIgnored || !e.is_ignored),
          );
          const idx = visible.findIndex((e) => e.name === focusTarget);
          if (idx !== -1) store.getState().setFocusedIndex(idx);
        }
      } catch (e) {
        console.error('list_dir failed:', e);
      } finally {
        store.getState().setIsLoading(false);
      }
    },
    [fileSend, store],
  );

  const selectFile = useCallback(
    async (path: string, _isDir: boolean) => {
      if (store.getState().selectedFile === path && store.getState().fileContent !== null) return;
      const previewGen = ++filePreviewGenRef.current;
      store.getState().setSelectedFile(path);
      store.getState().setSelectedDirectory(null);
      // Do not let the previous file's MIME type determine the new preview
      // while its content is being fetched (e.g. a PDF -> .tex transition).
      store.getState().setFileContent(null);
      store.getState().setDirectoryTree(null);
      const ext = path.split('.').pop()?.toLowerCase() || '';
      if (MEDIA_EXTENSIONS.has(ext)) {
        store.getState().setFileContent({
          path,
          content: '',
          mime_type: ext === 'pdf' ? 'application/pdf' : ext,
          encoding: 'binary',
          size: 0,
          truncated: false,
        });
        return;
      }
      try {
        const resp = await fileSend('read_file', { root: currentPath, path });
        // Focus can move again before the request completes. Only the latest
        // request may update the preview.
        if (filePreviewGenRef.current === previewGen && store.getState().selectedFile === path) {
          store.getState().setFileContent(resp.payload as unknown as FileContent);
        }
      } catch (e) {
        console.error('read_file failed:', e);
      }
    },
    [fileSend, currentPath, store],
  );

  const selectDir = useCallback(
    async (path: string, depth?: number) => {
      const previewGen = ++filePreviewGenRef.current;
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      store.getState().setSelectedDirectory(path);
      store.getState().setDirectoryTree(null);
      const resolvedDepth = depth ?? store.getState().treeDepth;
      try {
        const resp = await fileSend('list_tree', { root: path, path: '.', max_depth: resolvedDepth, max_items: 200 });
        if (filePreviewGenRef.current === previewGen) {
          store.getState().setDirectoryTree(resp.payload as unknown as TreeNode);
        }
      } catch (e) {
        console.error('list_tree failed:', e);
      }
    },
    [fileSend, store],
  );

  const enterGitMode = useCallback(
    async (path: string) => {
      store.getState().setIsGitMode(true);
      store.getState().setGitView('status');
      store.getState().setGitFocusedIndex(0);
      store.getState().setGitLogFocusedIndex(0);
      store.getState().setGitStatus(null);
      store.getState().setGitLog(null);
      store.getState().setGitDiff(null);
      store.getState().setGitCommitDiff(null);
      try {
        const resp = await fileSend('git_status', { path, include_diff_stats: true });
        const status = resp.payload as unknown as GitStatusResult;
        store.getState().setGitStatus(status);
        if (status.is_repo) {
          const logResp = await fileSend('git_log', { path, max_count: 200 });
          store.getState().setGitLog(logResp.payload as unknown as GitLogResult);
        } else {
          store.getState().setGitLog({ commits: [], truncated: false });
        }
      } catch (e) {
        console.error('git mode load failed:', e);
        store.getState().setIsGitMode(false);
      }
    },
    [fileSend, store],
  );

  const exitGitMode = useCallback(() => {
    store.getState().setIsGitMode(false);
    store.getState().setGitView('status');
    store.getState().setGitLog(null);
    store.getState().setGitDiff(null);
    store.getState().setGitCommitDiff(null);
    onClose();
  }, [onClose, store]);

  const gitStage = useCallback(
    async (paths: string | string[]) => {
      try {
        for (const path of typeof paths === 'string' ? [paths] : paths) {
          const resp = await fileSend('git_stage', { path, cwd: currentPath });
          const payload = resp.payload as { status: GitStatusResult };
          store.getState().setGitStatus(payload.status);
        }
      } catch (e) {
        console.error('git_stage failed:', e);
      }
    },
    [fileSend, currentPath, store],
  );

  const gitUnstage = useCallback(
    async (path: string) => {
      try {
        const resp = await fileSend('git_unstage', { path, cwd: currentPath });
        const payload = resp.payload as { status: GitStatusResult };
        store.getState().setGitStatus(payload.status);
      } catch (e) {
        console.error('git_unstage failed:', e);
      }
    },
    [fileSend, currentPath, store],
  );

  const gitDiscard = useCallback(
    async (path: string, untracked: boolean) => {
      try {
        const resp = await fileSend(untracked ? 'git_delete_untracked' : 'git_discard', { path, cwd: currentPath });
        const payload = resp.payload as { status: GitStatusResult };
        store.getState().setGitStatus(payload.status);
        if (untracked && store.getState().gitDiff?.path === path) store.getState().setGitDiff(null);
      } catch (e) {
        console.error(`${untracked ? 'git_delete_untracked' : 'git_discard'} failed:`, e);
      }
    },
    [fileSend, currentPath, store],
  );

  const gitCommit = useCallback(
    async (subject: string, body: string) => {
      try {
        const resp = await fileSend('git_commit', { subject, body, cwd: currentPath });
        const payload = resp.payload as { status: GitStatusResult };
        store.getState().setGitStatus(payload.status);
        store.getState().setGitDiff(null);
        store.getState().setGitCommitDiff(null);
        try {
          const logResp = await fileSend('git_log', { path: currentPath, max_count: 200 });
          store.getState().setGitLog(logResp.payload as unknown as GitLogResult);
        } catch (e) {
          console.error('git_log failed after commit:', e);
        }
      } catch (e) {
        console.error('git_commit failed:', e);
        throw e;
      }
    },
    [fileSend, currentPath, store],
  );

  const trashFile = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        try {
          await fileSend('trash_file', { root: currentPath, path });
        } catch (e) {
          console.error('trash_file failed:', e);
        }
      }
      store.getState().clearSelection();
      await navigate(currentPath);
    },
    [fileSend, currentPath, navigate, store],
  );

  const deleteFile = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        try {
          await fileSend('delete_file', { root: currentPath, path });
        } catch (e) {
          console.error('delete_file failed:', e);
        }
      }
      store.getState().clearSelection();
      await navigate(currentPath);
    },
    [fileSend, currentPath, navigate, store],
  );

  const pasteEntries = useCallback(async () => {
    const reg = store.getState().yankRegister;
    if (!reg || reg.paths.length === 0) return;
    const dest = store.getState().currentPath;
    try {
      if (reg.mode === 'cut') {
        await fileSend('move_entries', { paths: reg.paths, dest });
        store.getState().setYankRegister(null);
      } else {
        await fileSend('copy_entries', { paths: reg.paths, dest });
      }
    } catch (e) {
      console.error('paste failed:', e);
    }
    store.getState().clearSelection();
    await navigate(dest);
  }, [fileSend, navigate, store]);

  const commitRename = useCallback(
    async (newName: string) => {
      const { pendingRename } = store.getState();
      if (!pendingRename || !newName.trim()) {
        store.getState().setPendingRename(null);
        return;
      }
      const dir = pendingRename.path.slice(0, pendingRename.path.lastIndexOf('/') + 1);
      const to = dir + newName.trim();
      if (to === pendingRename.path) {
        store.getState().setPendingRename(null);
        return;
      }
      try {
        await fileSend('rename_file', { from: pendingRename.path, to });
      } catch (e) {
        console.error('rename_file failed:', e);
      }
      store.getState().setPendingRename(null);
      await navigate(currentPath, newName.trim());
    },
    [fileSend, currentPath, navigate, store],
  );

  // Focus rename input when it appears
  useEffect(() => {
    if (pendingRename) {
      setRenameValue(pendingRename.name);
      window.setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [pendingRename]);

  // Auto-preview diff when git focused index changes
  useEffect(() => {
    if (!isGitMode || gitView !== 'status' || !gitStatus) {
      store.getState().setGitDiff(null);
      return;
    }
    const items = visibleGitItems(gitStatus, gitExpandedSections, isFilterActive, filterQuery);
    const item = items[gitFocusedIndex];
    if (!item || item.kind === 'section-header' || !item.path) {
      store.getState().setGitDiff(null);
      return;
    }
    const gen = ++gitPreviewGenRef.current;
    const staged = item.section === 'staged';
    fileSend('git_diff', { path: item.path, staged, cwd: currentPath, ignore_all_space: ignoreAllSpace }).then(
      (resp) => {
        if (gitPreviewGenRef.current === gen) {
          store.getState().setGitDiff(resp.payload as unknown as FileDiff);
        }
      },
      () => {},
    );
  }, [
    isGitMode,
    gitView,
    gitFocusedIndex,
    gitStatus,
    gitExpandedSections,
    isFilterActive,
    filterQuery,
    fileSend,
    currentPath,
    ignoreAllSpace,
    store,
  ]);

  useEffect(() => {
    if (!isGitMode || gitView !== 'log' || !gitLog) {
      store.getState().setGitCommitDiff(null);
      return;
    }

    const commit = gitLog.commits[gitLogFocusedIndex];
    if (!commit) {
      store.getState().setGitCommitDiff(null);
      return;
    }

    const gen = ++gitCommitPreviewGenRef.current;
    store.getState().setGitCommitDiff(null);
    fileSend('git_commit_diff', { commit_id: commit.id, cwd: currentPath }).then(
      (resp) => {
        if (gitCommitPreviewGenRef.current === gen) {
          store.getState().setGitCommitDiff(resp.payload as unknown as GitCommitDiffResult);
        }
      },
      () => {},
    );
  }, [isGitMode, gitView, gitLog, gitLogFocusedIndex, fileSend, currentPath, store]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const startPath = cwd || '/';
    const focusFile = fileBrowserInitialMode === 'files' ? (fileBrowserFocusFile ?? undefined) : undefined;
    if (focusFile) {
      store.getState().setIsFilterActive(false);
      store.getState().setSearchMode('off');
    }
    void navigate(startPath, focusFile).then(() => setBrowserReady(true));
  }, [cwd, fileBrowserFocusFile, fileBrowserInitialMode, navigate, store]);

  useEffect(() => {
    if (!browserReady) return;
    if (fileBrowserInitialMode === 'git') {
      void enterGitMode(currentPath);
    } else {
      store.getState().setIsGitMode(false);
      store.getState().setGitDiff(null);
    }
  }, [browserReady, currentPath, enterGitMode, fileBrowserInitialMode, store]);

  const insertPath = useCallback(
    (path: string) => {
      send({ type: 'write_pane_input', session_id: sessionId, pane_id: paneId, text: path });
      onClose();
    },
    [send, onClose, sessionId, paneId],
  );

  const exitSearch = useCallback(() => {
    store.getState().setSearchMode('off');
    store.getState().setSearchQuery('');
    store.getState().setSearchResults([]);
    store.getState().setContentSearchResults([]);
    store.getState().setFocusedIndex(0);

    // The search input owns focus while open. Restore keyboard focus after it
    // unmounts so the overlay can continue handling navigation keys.
    window.setTimeout(() => rootRef.current?.focus(), 0);
  }, [store]);

  const openPath = useCallback(
    (path: string, isDir: boolean, line?: number) => {
      if (isDir) {
        send({ type: 'write_pane_input', session_id: sessionId, pane_id: paneId, text: `cd ${shellQuote(path)}\n` });
      } else {
        send({ type: 'open_file', pane_id: paneId, path, line: line ?? null });
      }
      onClose();
    },
    [send, onClose, sessionId, paneId],
  );

  // Auto-preview focused entry (file, directory, or search result)
  useEffect(() => {
    if (searchMode !== 'off') {
      const results = searchMode === 'files' ? searchResults : contentSearchResults;
      const result = results[focusedIndex] as { path: string } | undefined;
      if (!result) return;
      selectFile(result.path, false);
      return;
    }
    const visible = entries.filter((entry) => {
      if (!showDotFiles && entry.name.startsWith('.')) return false;
      if (!showIgnored && entry.is_ignored) return false;
      if (isFilterActive && filterQuery) {
        return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
      }
      return true;
    });
    const entry = visible[focusedIndex];
    if (!entry) return;
    const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    if (entry.is_dir) {
      selectDir(fullPath, treeDepth);
    } else {
      selectFile(fullPath, false);
    }
  }, [
    focusedIndex,
    entries,
    currentPath,
    showDotFiles,
    showIgnored,
    isFilterActive,
    filterQuery,
    treeDepth,
    searchMode,
    searchResults,
    contentSearchResults,
    selectFile,
    selectDir,
  ]);

  // Track whether this pane is the active one, and focus/blur accordingly
  const allSessions = useStore((s) => s.allSessions);
  const activePaneId = (() => {
    const session = allSessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const win = session.windows[session.active_window];
    return win?.panes[win.active_pane]?.id ?? null;
  })();
  const isActive = activePaneId === paneId;
  const prevIsActive = useRef(false);
  useEffect(() => {
    const wasActive = prevIsActive.current;
    prevIsActive.current = isActive;
    if (isActive && !wasActive) {
      const id = window.setTimeout(() => rootRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [isActive]);

  // Auto-focus on mount.
  useEffect(() => {
    const id = window.setTimeout(() => rootRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // Keyboard handler — only active while this overlay (or a child) has focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (commitModalOpen || !rootRef.current?.contains(document.activeElement)) return;

      // Rename input eats its own keys — let it handle Escape/Enter only
      if (pendingRename && document.activeElement === renameInputRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          store.getState().setPendingRename(null);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commitRename(renameValue);
        }
        return;
      }

      // Let the global keybinding handler consume prefix sequences.
      if (useStore.getState().prefixActive) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (pendingDiscard) {
          setPendingDiscard(null);
        } else if (pendingDelete) {
          setPendingDelete(null);
        } else if (selectedPaths.size > 0) {
          store.getState().clearSelection();
        } else if (searchMode !== 'off') {
          exitSearch();
        } else if (isFilterActive) {
          store.getState().setIsFilterActive(false);
        } else if (isGitMode) {
          exitGitMode();
        } else {
          onClose();
        }
        return;
      }

      if (pendingDiscard) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'y' || e.key === 'Y') {
          const { path, untracked } = pendingDiscard;
          setPendingDiscard(null);
          gitDiscard(path, untracked);
        } else if (e.key === 'n' || e.key === 'N') {
          setPendingDiscard(null);
        }
        return;
      }

      if (pendingDelete) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'y' || e.key === 'Y') {
          const { paths, permanent } = pendingDelete;
          setPendingDelete(null);
          if (permanent) {
            deleteFile(paths);
          } else {
            trashFile(paths);
          }
        } else if (e.key === 'n' || e.key === 'N') {
          setPendingDelete(null);
        }
        return;
      }

      // Git mode keybindings
      if (isGitMode) {
        if (gitView === 'log') {
          const count = gitLog?.commits.length ?? 0;
          const lastIndex = Math.max(count - 1, 0);

          if (e.ctrlKey && e.key === 'd') {
            e.preventDefault();
            scrollFilePreview(1);
            return;
          }
          if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            scrollFilePreview(-1);
            return;
          }
          if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            store.getState().setGitLogFocusedIndex(Math.min(gitLogFocusedIndex + 1, lastIndex));
            return;
          }
          if (e.ctrlKey && e.key === 'p') {
            e.preventDefault();
            store.getState().setGitLogFocusedIndex(Math.max(gitLogFocusedIndex - 1, 0));
            return;
          }

          switch (e.key) {
            case 'j':
            case 'ArrowDown':
              e.preventDefault();
              store.getState().setGitLogFocusedIndex(Math.min(gitLogFocusedIndex + 1, lastIndex));
              break;
            case 'k':
            case 'ArrowUp':
              e.preventDefault();
              store.getState().setGitLogFocusedIndex(Math.max(gitLogFocusedIndex - 1, 0));
              break;
            case 'g':
              e.preventDefault();
              store.getState().setGitLogFocusedIndex(0);
              break;
            case 'G':
              e.preventDefault();
              store.getState().setGitLogFocusedIndex(lastIndex);
              break;
            case 's':
              e.preventDefault();
              store.getState().setGitView('status');
              store.getState().setGitCommitDiff(null);
              break;
            case 'q':
              e.preventDefault();
              exitGitMode();
              break;
          }
          return;
        }

        const items = gitStatus ? visibleGitItems(gitStatus, gitExpandedSections, isFilterActive, filterQuery) : [];
        const count = items.length;

        if (isFilterActive) {
          if (e.key === 'Enter') {
            e.preventDefault();
            store.getState().setIsFilterActive(false);
            return;
          }
          if (e.key === 'Backspace') {
            e.preventDefault();
            store.getState().setFilterQuery(filterQuery.slice(0, -1));
            return;
          }
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            store.getState().setFilterQuery(filterQuery + e.key);
            return;
          }
          if (!e.ctrlKey) return;
        }

        if (e.ctrlKey && e.key === 'd') {
          e.preventDefault();
          scrollFilePreview(1);
          return;
        }
        if (e.ctrlKey && e.key === 'u') {
          e.preventDefault();
          scrollFilePreview(-1);
          return;
        }
        if (e.ctrlKey && e.key === 'n') {
          e.preventDefault();
          store.getState().setGitFocusedIndex(Math.min(gitFocusedIndex + 1, count - 1));
          return;
        }
        if (e.ctrlKey && e.key === 'p') {
          e.preventDefault();
          store.getState().setGitFocusedIndex(Math.max(gitFocusedIndex - 1, 0));
          return;
        }

        switch (e.key) {
          case 'j':
          case 'ArrowDown':
            e.preventDefault();
            store.getState().setGitFocusedIndex(Math.min(gitFocusedIndex + 1, count - 1));
            break;
          case 'k':
          case 'ArrowUp':
            e.preventDefault();
            store.getState().setGitFocusedIndex(Math.max(gitFocusedIndex - 1, 0));
            break;
          case 'Tab': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'section-header') {
              store.getState().toggleGitSection(item.section);
            }
            break;
          }
          case 'h': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'section-header' && gitExpandedSections.has(item.section)) {
              store.getState().toggleGitSection(item.section);
            }
            break;
          }
          case 'o':
            e.preventDefault();
            store.getState().setGitView('log');
            store.getState().setGitDiff(null);
            break;
          case 'l': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'section-header' && !gitExpandedSections.has(item.section)) {
              store.getState().toggleGitSection(item.section);
            }
            break;
          }
          case 's': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'file' && item.path && item.section !== 'staged') {
              gitStage(item.path);
            } else if (item?.kind === 'section-header' && gitStatus) {
              if (item.section === 'unstaged') {
                gitStage(gitStatus.unstaged.map((entry) => entry.path));
              } else if (item.section === 'untracked') {
                gitStage([...gitStatus.untracked]);
              }
            }
            break;
          }
          case 'u': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'file' && item.path && item.section === 'staged') {
              gitUnstage(item.path);
            }
            break;
          }
          case 'x': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'file' && item.path && (item.section === 'unstaged' || item.section === 'untracked')) {
              setPendingDiscard({ path: item.path, untracked: item.section === 'untracked' });
            }
            break;
          }
          case 'w':
            e.preventDefault();
            setIgnoreAllSpace((enabled) => !enabled);
            break;
          case 'Enter': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'file' && item.path) {
              const line = gitDiff?.path === item.path ? gitDiff.hunks[0]?.new_start : undefined;
              openPath(item.path, false, line);
            }
            break;
          }
          case 'g':
            e.preventDefault();
            store.getState().setGitFocusedIndex(0);
            break;
          case 'q':
            e.preventDefault();
            exitGitMode();
            break;
          case 'c':
            e.preventDefault();
            if (gitStatus?.is_repo) setCommitModalOpen(true);
            break;
          case 'G':
            e.preventDefault();
            store.getState().setGitFocusedIndex(count - 1);
            break;
          case '/':
            e.preventDefault();
            store.getState().setIsFilterActive(true);
            break;
        }
        return;
      }

      // Search mode keybindings
      if (searchMode !== 'off') {
        const results = searchMode === 'files' ? searchResults : contentSearchResults;
        if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
          e.preventDefault();
          store.getState().setFocusedIndex(Math.min(focusedIndex + 1, results.length - 1));
          return;
        }
        if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
          e.preventDefault();
          store.getState().setFocusedIndex(Math.max(focusedIndex - 1, 0));
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          store.getState().setSearchMode(searchMode === 'files' ? 'content' : 'files');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const result = results[focusedIndex] as (FileSearchResult | SearchResult) | undefined;
          if (result) {
            if (e.ctrlKey) {
              insertPath(result.path);
            } else {
              const line = searchMode === 'content' ? ((result as SearchResult).line ?? undefined) : undefined;
              openPath(result.path, false, line);
            }
          }
          return;
        }
        // Let all other keys go to the input inside FileSearch
        return;
      }

      if (isFilterActive) {
        if (e.key === 'Enter') {
          e.preventDefault();
          store.getState().setIsFilterActive(false);
          const vis = entries.filter((entry) => {
            if (!showDotFiles && entry.name.startsWith('.')) return false;
            if (!showIgnored && entry.is_ignored) return false;
            if (filterQuery) {
              return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
            }
            return true;
          });
          const entry = vis[focusedIndex];
          if (entry) {
            const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
            if (e.ctrlKey) {
              insertPath(fullPath);
            } else if (entry.is_dir) {
              navigate(fullPath);
            } else {
              openPath(fullPath, false);
            }
          }
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          store.getState().setFilterQuery(filterQuery.slice(0, -1));
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          store.getState().setFilterQuery(filterQuery + e.key);
          return;
        }
        if (e.ctrlKey && (e.key === 'n' || e.key === 'p')) {
          e.preventDefault();
          const vis = entries.filter((entry) => {
            if (!showDotFiles && entry.name.startsWith('.')) return false;
            if (!showIgnored && entry.is_ignored) return false;
            if (filterQuery) return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
            return true;
          });
          const next = e.key === 'n' ? Math.min(focusedIndex + 1, vis.length - 1) : Math.max(focusedIndex - 1, 0);
          store.getState().setFocusedIndex(next);
          return;
        }
        if (!e.ctrlKey) return;
      }

      const visible = entries.filter((entry) => {
        if (!showDotFiles && entry.name.startsWith('.')) return false;
        if (!showIgnored && entry.is_ignored) return false;
        if (isFilterActive && filterQuery) {
          return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
        }
        return true;
      });

      const focusedEntry = visible[focusedIndex];
      const focusedFullPath = focusedEntry
        ? currentPath === '/'
          ? `/${focusedEntry.name}`
          : `${currentPath}/${focusedEntry.name}`
        : null;

      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        if (focusedEntry?.is_dir && focusedFullPath) {
          const newDepth = treeDepth + 1;
          store.getState().setTreeDepth(newDepth);
          selectDir(focusedFullPath, newDepth);
        } else {
          store.getState().setFocusedIndex(Math.min(focusedIndex + 1, visible.length - 1));
        }
        return;
      }
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        if (focusedEntry?.is_dir && focusedFullPath) {
          const newDepth = Math.max(1, treeDepth - 1);
          store.getState().setTreeDepth(newDepth);
          selectDir(focusedFullPath, newDepth);
        } else {
          store.getState().setFocusedIndex(Math.max(focusedIndex - 1, 0));
        }
        return;
      }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        scrollFilePreview(1);
        return;
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        scrollFilePreview(-1);
        return;
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          store.getState().setFocusedIndex(Math.min(focusedIndex + 1, visible.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          store.getState().setFocusedIndex(Math.max(focusedIndex - 1, 0));
          break;
        case ' ': {
          // Toggle selection on focused entry, advance cursor
          e.preventDefault();
          if (!focusedFullPath) break;
          store.getState().toggleSelectedPath(focusedFullPath);
          store.getState().setFocusedIndex(Math.min(focusedIndex + 1, visible.length - 1));
          break;
        }
        case 'Enter': {
          e.preventDefault();
          if (!focusedEntry || !focusedFullPath) break;
          if (e.ctrlKey) {
            insertPath(focusedFullPath);
          } else if (focusedEntry.is_dir) {
            navigate(focusedFullPath);
          } else {
            openPath(focusedFullPath, false);
          }
          break;
        }
        case 'l':
        case 'ArrowRight': {
          e.preventDefault();
          if (!focusedEntry || !focusedFullPath) break;
          if (focusedEntry.is_dir) {
            navigate(focusedFullPath);
          } else {
            selectFile(focusedFullPath, false);
          }
          break;
        }
        case 'h':
        case 'ArrowLeft':
        case 'Backspace': {
          e.preventDefault();
          const basename = currentPath.slice(currentPath.lastIndexOf('/') + 1);
          navigate(getParent(currentPath), basename || undefined);
          break;
        }
        case '/':
          e.preventDefault();
          store.getState().setIsFilterActive(true);
          break;
        case 'f':
        case 's':
          e.preventDefault();
          store.getState().setSearchMode(e.key === 's' ? 'content' : 'files');
          store.getState().setSearchQuery('');
          store.getState().setSearchResults([]);
          store.getState().setContentSearchResults([]);
          store.getState().setFocusedIndex(0);
          break;
        case '.':
          e.preventDefault();
          store.getState().setShowDotFiles(!showDotFiles);
          break;
        case 'i':
          e.preventDefault();
          store.getState().setShowIgnored(!showIgnored);
          break;
        case 'g':
          e.preventDefault();
          store.getState().setFocusedIndex(0);
          break;
        case 'G':
          e.preventDefault();
          store.getState().setFocusedIndex(visible.length - 1);
          break;
        case '~':
          e.preventDefault();
          navigate('~');
          break;
        case 'q':
          e.preventDefault();
          onClose();
          break;
        case 'r': {
          // Rename focused entry
          e.preventDefault();
          if (!focusedEntry || !focusedFullPath) break;
          store.getState().setPendingRename({ path: focusedFullPath, name: focusedEntry.name });
          break;
        }
        case 'y': {
          // Yank (copy) — selected set or focused entry
          e.preventDefault();
          const paths = selectedPaths.size > 0 ? Array.from(selectedPaths) : focusedFullPath ? [focusedFullPath] : [];
          if (paths.length === 0) break;
          store.getState().setYankRegister({ paths, mode: 'copy' });
          break;
        }
        case 'x': {
          // Cut — selected set or focused entry
          e.preventDefault();
          const paths = selectedPaths.size > 0 ? Array.from(selectedPaths) : focusedFullPath ? [focusedFullPath] : [];
          if (paths.length === 0) break;
          store.getState().setYankRegister({ paths, mode: 'cut' });
          break;
        }
        case 'p': {
          // Paste yank register into current directory
          e.preventDefault();
          pasteEntries();
          break;
        }
        case 'd': {
          e.preventDefault();
          if (!focusedEntry && selectedPaths.size === 0) break;
          const paths = selectedPaths.size > 0 ? Array.from(selectedPaths) : focusedFullPath ? [focusedFullPath] : [];
          const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
          setPendingDelete({ paths, names, permanent: false });
          break;
        }
        case 'D': {
          e.preventDefault();
          if (!focusedEntry && selectedPaths.size === 0) break;
          const paths = selectedPaths.size > 0 ? Array.from(selectedPaths) : focusedFullPath ? [focusedFullPath] : [];
          const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
          setPendingDelete({ paths, names, permanent: true });
          break;
        }
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    entries,
    focusedIndex,
    currentPath,
    isFilterActive,
    filterQuery,
    showDotFiles,
    showIgnored,
    isGitMode,
    gitView,
    gitStatus,
    gitLog,
    gitDiff,
    gitFocusedIndex,
    gitLogFocusedIndex,
    gitExpandedSections,
    treeDepth,
    navigate,
    selectFile,
    selectDir,
    insertPath,
    openPath,
    onClose,
    exitGitMode,
    gitStage,
    gitUnstage,
    gitDiscard,
    gitCommit,
    trashFile,
    deleteFile,
    pendingDiscard,
    pendingDelete,
    commitModalOpen,
    pendingRename,
    renameValue,
    commitRename,
    setIgnoreAllSpace,
    selectedPaths,
    yankRegister,
    pasteEntries,
    searchMode,
    searchResults,
    contentSearchResults,
    exitSearch,
    store,
  ]);

  const focusedEntryIsDir = (() => {
    const visible = entries.filter((entry) => {
      if (!showDotFiles && entry.name.startsWith('.')) return false;
      if (!showIgnored && entry.is_ignored) return false;
      if (isFilterActive && filterQuery) return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
      return true;
    });
    return visible[focusedIndex]?.is_dir ?? false;
  })();

  const selectionCount = selectedPaths.size;

  const hints: Hint[] = isGitMode
    ? gitView === 'log'
      ? GIT_LOG_HINTS
      : [
          ...GIT_STATUS_HINTS,
          {
            keys: ['w'],
            label: (
              <Text
                type="code"
                size="sm"
                color={ignoreAllSpace ? 'inherit' : 'disabled'}
                className={cn(ignoreAllSpace && 'text-cyan-vivid')}
                style={{ fontVariantLigatures: 'none' }}
              >
                -w/--ignore-all-space
              </Text>
            ),
          },
          ...GIT_STATUS_TAIL_HINTS,
        ]
    : searchMode !== 'off'
      ? [
          { keys: ['up', 'down'], label: 'navigate' },
          { keys: ['enter'], label: searchMode === 'content' ? 'open at line' : 'open' },
          { keys: ['ctrl+enter'], label: 'insert path' },
          { keys: ['tab'], label: searchMode === 'files' ? 'content search' : 'file search' },
          { keys: ['esc'], label: 'exit search' },
        ]
      : [
          { keys: ['j', 'k'], label: 'navigate' },
          { keys: ['space'], label: 'select' },
          { keys: ['ctrl+n', 'ctrl+p'], label: focusedEntryIsDir ? `depth (${treeDepth})` : 'navigate' },
          ...BROWSE_HINTS,
        ];

  return (
    <VStack
      ref={rootRef}
      tabIndex={-1}
      className="h-full min-h-0 overflow-hidden outline-none"
      style={{ fontSize: `${fontSize}px` }}
      onMouseDown={() => {
        if (!isActive) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
        rootRef.current?.focus();
      }}
    >
      <HStack gap={3} vAlign="center" className="min-w-0 flex-none border-b border-border px-3 py-1.5">
        <HStack className="min-w-0 flex-1 overflow-hidden">
          <Breadcrumb onNavigate={navigate} />
        </HStack>
        {fileConnectionState !== 'connected' && (
          <Text size="sm" color="secondary" role="status" className={cn(animations && 'animate-pulse')}>
            {CONNECTION_STATE_LABEL[fileConnectionState]}
          </Text>
        )}
        {isFilterActive && (
          <Text size="sm" color="secondary">
            Filter: <Text size="sm">{filterQuery || '…'}</Text>
          </Text>
        )}
        {selectionCount > 0 && !isFilterActive && <Token size="sm" color="blue" label={`${selectionCount} selected`} />}
        {yankRegister && !isFilterActive && (
          <Token
            size="sm"
            label={`${yankRegister.paths.length} ${yankRegister.mode === 'cut' ? 'to move' : 'to copy'}`}
          />
        )}
        <IconButton label="Close file browser" icon={<X />} variant="ghost" size="sm" onClick={onClose} />
      </HStack>

      <HStack className="min-h-0 min-w-0 flex-1 items-stretch overflow-hidden">
        <VStack className="min-h-0 min-w-0 flex-none overflow-hidden" style={{ width: `${sidebarRatio * 100}%` }}>
          {isGitMode ? (
            <>
              <GitModeHeader />
              {gitView === 'log' ? <GitHistory /> : <GitStatus />}
            </>
          ) : (
            <>
              <VStack className={searchMode === 'off' ? 'min-h-0 flex-1' : 'hidden'}>
                <FileTree fileSend={fileSend} onNavigate={navigate} onSelect={selectFile} />
              </VStack>
              {searchMode !== 'off' && (
                <FileSearch fileSend={fileSend} currentPath={currentPath} focusedIndex={focusedIndex} />
              )}
            </>
          )}
        </VStack>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={onDividerMouseDown}
          className="w-1 flex-none cursor-col-resize border-r border-border hover:bg-accent-bg active:bg-accent-bg"
        />
        <VStack className="file-preview-scroll file-preview-content min-h-0 min-w-0 flex-1">
          {isGitMode && gitView === 'log' ? <GitCommitDiffPreview /> : <FilePreview fileSend={fileSend} />}
        </VStack>
      </HStack>

      <HStack gap={4} vAlign="center" className="flex-none overflow-hidden border-t border-border px-3 py-1">
        {pendingRename ? (
          <HStack gap={3} vAlign="center" className="w-full">
            <TextInput
              ref={renameInputRef}
              label="Rename"
              isLabelHidden
              size="sm"
              value={renameValue}
              onChange={setRenameValue}
              className="min-w-0 flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename(renameValue);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  store.getState().setPendingRename(null);
                }
                e.stopPropagation();
              }}
            />
            <KeyHint keys={['enter']} label="confirm" />
            <KeyHint keys={['esc']} label="cancel" />
          </HStack>
        ) : pendingDiscard || pendingDelete ? (
          <>
            <Text size="sm">
              {pendingDiscard
                ? pendingDiscard.untracked
                  ? 'Permanently delete untracked file '
                  : 'Discard changes to '
                : pendingDelete!.permanent
                  ? 'Permanently delete '
                  : 'Move to trash '}
              <Text size="sm" color="inherit" className="text-yellow-vivid">
                {pendingDiscard
                  ? pendingDiscard.path
                  : pendingDelete!.names.length === 1
                    ? pendingDelete!.names[0]
                    : `${pendingDelete!.names.length} items`}
              </Text>
              ?
            </Text>
            <KeyHint keys={['y']} label="confirm" />
            <KeyHint keys={['n']} label="cancel" />
          </>
        ) : (
          hints.map((hint) => <KeyHint key={hint.keys.join()} keys={hint.keys} label={hint.label} />)
        )}
      </HStack>

      <GitCommitModal open={commitModalOpen} onOpenChange={handleCommitModalOpenChange} onCommit={gitCommit} />
    </VStack>
  );
}

interface Hint {
  keys: string[];
  label: ReactNode;
}

function KeyHint({ keys, label }: Hint) {
  return (
    <HStack gap={1} vAlign="center" className="flex-none">
      {keys.map((key) => (
        <Kbd key={key} keys={key} />
      ))}
      {typeof label === 'string' ? (
        <Text size="sm" color="secondary">
          {label}
        </Text>
      ) : (
        label
      )}
    </HStack>
  );
}

const GIT_LOG_HINTS: Hint[] = [
  { keys: ['j', 'k'], label: 'navigate commits' },
  { keys: ['g', 'shift+g'], label: 'top/bottom' },
  { keys: ['s'], label: 'status' },
  { keys: ['esc', 'q'], label: 'exit git' },
];

const GIT_STATUS_HINTS: Hint[] = [
  { keys: ['j', 'k'], label: 'navigate' },
  { keys: ['tab'], label: 'expand' },
  { keys: ['h', 'l'], label: 'fold/unfold' },
  { keys: ['s'], label: 'stage' },
  { keys: ['u'], label: 'unstage' },
  { keys: ['x'], label: 'discard' },
];

const GIT_STATUS_TAIL_HINTS: Hint[] = [
  { keys: ['c'], label: 'commit' },
  { keys: ['/'], label: 'filter' },
  { keys: ['o'], label: 'log' },
  { keys: ['esc', 'q'], label: 'exit git' },
];

const BROWSE_HINTS: Hint[] = [
  { keys: ['y'], label: 'copy' },
  { keys: ['x'], label: 'cut' },
  { keys: ['p'], label: 'paste' },
  { keys: ['r'], label: 'rename' },
  { keys: ['enter'], label: 'open' },
  { keys: ['ctrl+enter'], label: 'insert path' },
  { keys: ['l'], label: 'preview' },
  { keys: ['h'], label: 'up' },
  { keys: ['ctrl+d', 'ctrl+u'], label: 'scroll' },
  { keys: ['/'], label: 'filter' },
  { keys: ['f', 's'], label: 'search' },
  { keys: ['.'], label: 'dotfiles' },
  { keys: ['i'], label: 'gitignored' },
  { keys: ['d'], label: 'trash' },
  { keys: ['shift+d'], label: 'delete' },
  { keys: ['q'], label: 'close' },
];
