import { useEffect, useCallback, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useFileSocket } from '@/hooks/useFileSocket';
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';
import { FileTree } from './files/FileTree';
import { FilePreview } from './files/FilePreview';
import { Breadcrumb } from './files/Breadcrumb';
import { GitModeHeader } from './files/GitModeHeader';
import { GitStatus, computeGitItems } from './files/GitStatus';
import { FileSearch } from './files/FileSearch';
import { getParent } from '@/lib/utils';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import type {
  FileEntry,
  FileContent,
  GitStatusResult,
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

interface FileBrowserOverlayProps {
  cwd: string | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function FileBrowserOverlay({ cwd, send, onClose }: FileBrowserOverlayProps) {
  const { send: fileSend } = useFileSocket();
  const config = useStore((s) => s.config);
  const fontSize = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));
  const currentPath = useFileStore((s) => s.currentPath);
  const entries = useFileStore((s) => s.entries);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const filterQuery = useFileStore((s) => s.filterQuery);
  const isFilterActive = useFileStore((s) => s.isFilterActive);
  const showDotFiles = useFileStore((s) => s.showDotFiles);
  const isGitMode = useFileStore((s) => s.isGitMode);
  const treeDepth = useFileStore((s) => s.treeDepth);
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitFocusedIndex = useFileStore((s) => s.gitFocusedIndex);
  const gitExpandedSections = useFileStore((s) => s.gitExpandedSections);
  const searchMode = useFileStore((s) => s.searchMode);
  const searchResults = useFileStore((s) => s.searchResults);
  const contentSearchResults = useFileStore((s) => s.contentSearchResults);
  const store = useFileStore;
  const initialized = useRef(false);
  const gitPreviewGenRef = useRef(0);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const dragging = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; name: string; permanent: boolean } | null>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.max(160, Math.min(ev.clientX, window.innerWidth * 0.5));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const navigate = useCallback(
    async (path: string, focusTarget?: string) => {
      store.getState().setIsLoading(true);
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      store.getState().setDirectoryTree(null);
      store.getState().setTreeDepth(1);
      try {
        const resp = await fileSend('list_dir', { root: path, path: '.' });
        const payload = resp.payload as { path: string; entries: FileEntry[] };
        store.getState().setCurrentPath(payload.path);
        store.getState().setEntries(payload.entries);
        if (focusTarget) {
          const { showDotFiles } = store.getState();
          const visible = payload.entries.filter(
            (e) => showDotFiles || !e.name.startsWith('.'),
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
      // Skip re-fetching if this file is already loaded — avoids clearing
      // fileContent (and disrupting scroll position) when cycling search results
      // within the same file.
      if (store.getState().selectedFile === path && store.getState().fileContent !== null) return;
      store.getState().setSelectedFile(path);
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
        store.getState().setFileContent(resp.payload as unknown as FileContent);
      } catch (e) {
        console.error('read_file failed:', e);
      }
    },
    [fileSend, currentPath, store],
  );

  const selectDir = useCallback(
    async (path: string, depth?: number) => {
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      const resolvedDepth = depth ?? store.getState().treeDepth;
      try {
        const resp = await fileSend('list_tree', { root: path, path: '.', max_depth: resolvedDepth, max_items: 200 });
        store.getState().setDirectoryTree(resp.payload as unknown as TreeNode);
      } catch (e) {
        console.error('list_tree failed:', e);
      }
    },
    [fileSend, store],
  );

  const toggleGitMode = useCallback(async () => {
    const { isGitMode } = store.getState();
    if (isGitMode) {
      store.getState().setIsGitMode(false);
      store.getState().setGitDiff(null);
    } else {
      store.getState().setIsGitMode(true);
      store.getState().setGitFocusedIndex(0);
      try {
        const resp = await fileSend('git_status', { path: currentPath });
        store.getState().setGitStatus(resp.payload as unknown as GitStatusResult);
      } catch (e) {
        console.error('git_status failed:', e);
        store.getState().setIsGitMode(false);
      }
    }
  }, [fileSend, currentPath, store]);

  const gitStage = useCallback(
    async (path: string) => {
      try {
        const resp = await fileSend('git_stage', { path, cwd: currentPath });
        const payload = resp.payload as { status: GitStatusResult };
        store.getState().setGitStatus(payload.status);
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
    async (path: string) => {
      try {
        const resp = await fileSend('git_discard', { path, cwd: currentPath });
        const payload = resp.payload as { status: GitStatusResult };
        store.getState().setGitStatus(payload.status);
      } catch (e) {
        console.error('git_discard failed:', e);
      }
    },
    [fileSend, currentPath, store],
  );

  const trashFile = useCallback(
    async (path: string) => {
      try {
        await fileSend('trash_file', { root: currentPath, path });
        await navigate(currentPath);
      } catch (e) {
        console.error('trash_file failed:', e);
      }
    },
    [fileSend, currentPath, navigate],
  );

  const deleteFile = useCallback(
    async (path: string) => {
      try {
        await fileSend('delete_file', { root: currentPath, path });
        await navigate(currentPath);
      } catch (e) {
        console.error('delete_file failed:', e);
      }
    },
    [fileSend, currentPath, navigate],
  );

  // Auto-preview diff when git focused index changes
  useEffect(() => {
    if (!isGitMode || !gitStatus) return;
    const items = computeGitItems(gitStatus, gitExpandedSections);
    const item = items[gitFocusedIndex];
    if (!item || item.kind === 'section-header' || !item.path) {
      store.getState().setGitDiff(null);
      return;
    }
    const gen = ++gitPreviewGenRef.current;
    const staged = item.section === 'staged';
    fileSend('git_diff', { path: item.path, staged, cwd: currentPath }).then(
      (resp) => {
        if (gitPreviewGenRef.current === gen) {
          store.getState().setGitDiff(resp.payload as unknown as FileDiff);
        }
      },
      () => {},
    );
  }, [isGitMode, gitFocusedIndex, gitStatus, gitExpandedSections, fileSend, currentPath, store]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const startPath = cwd || '/';
    navigate(startPath);
  }, [cwd, navigate]);

  const getActivePaneInfo = useCallback(() => {
    const mainStore = useStore.getState();
    const match = window.location.pathname.match(/^\/s\/([^/]+)/);
    const sessionName = match ? decodeURIComponent(match[1]) : null;
    const session = sessionName
      ? mainStore.allSessions.find((s) => s.name === sessionName)
      : mainStore.allSessions[0];
    if (!session) return null;
    const win = session.windows[session.active_window];
    if (!win) return null;
    const pane = win.panes[win.active_pane];
    if (!pane) return null;
    return { sessionId: session.id, paneId: pane.id };
  }, []);

  const insertPath = useCallback(
    (path: string) => {
      const info = getActivePaneInfo();
      if (!info) return;
      send({ type: 'write_pane_input', session_id: info.sessionId, pane_id: info.paneId, text: path });
      onClose();
    },
    [send, onClose, getActivePaneInfo],
  );

  const openPath = useCallback(
    (path: string, isDir: boolean) => {
      const info = getActivePaneInfo();
      if (!info) return;
      const text = isDir ? `cd ${path}\n` : `$EDITOR ${path}\n`;
      send({ type: 'write_pane_input', session_id: info.sessionId, pane_id: info.paneId, text });
      onClose();
    },
    [send, onClose, getActivePaneInfo],
  );

  const selectSearchResult = useCallback(
    (path: string, ctrlKey: boolean) => {
      if (ctrlKey) {
        openPath(path, false);
      } else {
        insertPath(path);
      }
    },
    [openPath, insertPath],
  );

  const navigateToSearchResult = useCallback(
    async (path: string) => {
      const lastSlash = path.lastIndexOf('/');
      const dir = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
      const name = path.slice(lastSlash + 1);
      store.getState().setSearchMode('off');
      store.getState().setSearchQuery('');
      await navigate(dir, name);
    },
    [navigate, store],
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
    isFilterActive,
    filterQuery,
    treeDepth,
    searchMode,
    searchResults,
    contentSearchResults,
    selectFile,
    selectDir,
  ]);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (pendingDelete) {
          setPendingDelete(null);
        } else if (searchMode !== 'off') {
          store.getState().setSearchMode('off');
          store.getState().setSearchQuery('');
        } else if (isFilterActive) {
          store.getState().setIsFilterActive(false);
        } else if (isGitMode) {
          store.getState().setIsGitMode(false);
          store.getState().setGitDiff(null);
        } else {
          onClose();
        }
        return;
      }

      if (pendingDelete) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'y' || e.key === 'Y') {
          const { path, permanent } = pendingDelete;
          setPendingDelete(null);
          if (permanent) {
            deleteFile(path);
          } else {
            trashFile(path);
          }
        } else if (e.key === 'n' || e.key === 'N') {
          setPendingDelete(null);
        }
        return;
      }

      // Git mode keybindings
      if (isGitMode) {
        const items = gitStatus ? computeGitItems(gitStatus, gitExpandedSections) : [];
        const count = items.length;

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
          case 's': {
            e.preventDefault();
            const item = items[gitFocusedIndex];
            if (item?.kind === 'file' && item.path && item.section !== 'staged') {
              gitStage(item.path);
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
            if (item?.kind === 'file' && item.path && item.section === 'unstaged') {
              gitDiscard(item.path);
            }
            break;
          }
          case 'g':
            e.preventDefault();
            store.getState().setGitFocusedIndex(0);
            break;
          case 'G':
            e.preventDefault();
            store.getState().setGitFocusedIndex(count - 1);
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
              selectSearchResult(result.path, true);
            } else {
              navigateToSearchResult(result.path);
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
            if (filterQuery) {
              return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
            }
            return true;
          });
          const entry = vis[focusedIndex];
          if (entry) {
            const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
            if (e.ctrlKey) {
              openPath(fullPath, entry.is_dir);
            } else if (entry.is_dir) {
              navigate(fullPath);
            } else {
              insertPath(fullPath);
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
        if (isFilterActive && filterQuery) {
          return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
        }
        return true;
      });

      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        const focusedEntry = visible[focusedIndex];
        if (focusedEntry?.is_dir) {
          const newDepth = treeDepth + 1;
          store.getState().setTreeDepth(newDepth);
          const fullPath = currentPath === '/' ? `/${focusedEntry.name}` : `${currentPath}/${focusedEntry.name}`;
          selectDir(fullPath, newDepth);
        } else {
          store.getState().setFocusedIndex(Math.min(focusedIndex + 1, visible.length - 1));
        }
        return;
      }
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        const focusedEntry = visible[focusedIndex];
        if (focusedEntry?.is_dir) {
          const newDepth = Math.max(1, treeDepth - 1);
          store.getState().setTreeDepth(newDepth);
          const fullPath = currentPath === '/' ? `/${focusedEntry.name}` : `${currentPath}/${focusedEntry.name}`;
          selectDir(fullPath, newDepth);
        } else {
          store.getState().setFocusedIndex(Math.max(focusedIndex - 1, 0));
        }
        return;
      }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        const viewport = document.querySelector('.file-preview-scroll [data-slot="scroll-area-viewport"]');
        if (viewport) viewport.scrollBy({ top: viewport.clientHeight / 2 });
        return;
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        const viewport = document.querySelector('.file-preview-scroll [data-slot="scroll-area-viewport"]');
        if (viewport) viewport.scrollBy({ top: -viewport.clientHeight / 2 });
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
        case 'Enter': {
          e.preventDefault();
          const entry = visible[focusedIndex];
          if (!entry) break;
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          if (e.ctrlKey) {
            openPath(fullPath, entry.is_dir);
          } else if (entry.is_dir) {
            navigate(fullPath);
          } else {
            insertPath(fullPath);
          }
          break;
        }
        case 'l':
        case 'ArrowRight': {
          e.preventDefault();
          const entry = visible[focusedIndex];
          if (!entry) break;
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          if (entry.is_dir) {
            navigate(fullPath);
          } else {
            selectFile(fullPath, false);
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
          e.preventDefault();
          store.getState().setSearchMode('files');
          store.getState().setSearchQuery('');
          store.getState().setSearchResults([]);
          store.getState().setContentSearchResults([]);
          store.getState().setFocusedIndex(0);
          break;
        case '.':
          e.preventDefault();
          store.getState().setShowDotFiles(!showDotFiles);
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
        case 's':
          e.preventDefault();
          toggleGitMode();
          break;
        case 'q':
          e.preventDefault();
          onClose();
          break;
        case 'd': {
          e.preventDefault();
          const entry = visible[focusedIndex];
          if (!entry) break;
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          setPendingDelete({ path: fullPath, name: entry.name, permanent: false });
          break;
        }
        case 'D': {
          e.preventDefault();
          const entry = visible[focusedIndex];
          if (!entry) break;
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          setPendingDelete({ path: fullPath, name: entry.name, permanent: true });
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
    isGitMode,
    gitStatus,
    gitFocusedIndex,
    gitExpandedSections,
    treeDepth,
    navigate,
    selectFile,
    selectDir,
    insertPath,
    openPath,
    onClose,
    toggleGitMode,
    gitStage,
    gitUnstage,
    gitDiscard,
    trashFile,
    deleteFile,
    pendingDelete,
    searchMode,
    searchResults,
    contentSearchResults,
    selectSearchResult,
    navigateToSearchResult,
    store,
  ]);

  const focusedEntryIsDir = (() => {
    const visible = entries.filter((entry) => {
      if (!showDotFiles && entry.name.startsWith('.')) return false;
      if (isFilterActive && filterQuery) return entry.name.toLowerCase().includes(filterQuery.toLowerCase());
      return true;
    });
    return visible[focusedIndex]?.is_dir ?? false;
  })();

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      style={{
        fontSize: `${fontSize}px`,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <Breadcrumb onNavigate={navigate} />
        <div className="flex-1" />
        {isFilterActive && (
          <div className="text-muted-foreground">
            filter: <span className="text-foreground">{filterQuery || '...'}</span>
          </div>
        )}
        <button
          onClick={onClose}
          className="p-1 hover:bg-accent rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="shrink-0 flex flex-col min-h-0 overflow-hidden" style={{ width: sidebarWidth }}>
          {isGitMode ? (
            <>
              <GitModeHeader />
              <GitStatus />
            </>
          ) : searchMode !== 'off' ? (
            <FileSearch fileSend={fileSend} currentPath={currentPath} focusedIndex={focusedIndex} />
          ) : (
            <FileTree onNavigate={navigate} onSelect={selectFile} />
          )}
        </div>
        {/* Drag handle */}
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1 shrink-0 cursor-col-resize border-r border-border hover:bg-accent active:bg-accent"
        />
        {/* Preview */}
        <div className="flex-1 flex flex-col min-h-0 file-preview-scroll">
          <FilePreview />
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-4 px-3 py-1 border-t border-border text-muted-foreground"
        style={{ fontSize: `${Math.max(6, fontSize - 2)}px` }}
      >
        {pendingDelete ? (
          <span className="text-foreground">
            {pendingDelete.permanent ? 'permanently delete' : 'move to trash'}{' '}
            <span className="text-yellow-400">{pendingDelete.name}</span>?{' '}
            <KbdGroup>
              <Kbd>y</Kbd>
            </KbdGroup>{' '}
            confirm{' '}
            <KbdGroup>
              <Kbd>n</Kbd>
            </KbdGroup>{' '}
            cancel
          </span>
        ) : isGitMode ? (
          <>
            <span>
              <KbdGroup>
                <Kbd>j</Kbd>
                <Kbd>k</Kbd>
              </KbdGroup>{' '}
              navigate
            </span>
            <span>
              <KbdGroup>
                <Kbd>Tab</Kbd>
              </KbdGroup>{' '}
              expand
            </span>
            <span>
              <KbdGroup>
                <Kbd>s</Kbd>
              </KbdGroup>{' '}
              stage
            </span>
            <span>
              <KbdGroup>
                <Kbd>u</Kbd>
              </KbdGroup>{' '}
              unstage
            </span>
            <span>
              <KbdGroup>
                <Kbd>x</Kbd>
              </KbdGroup>{' '}
              discard
            </span>
            <span>
              <KbdGroup>
                <Kbd>Esc</Kbd>
              </KbdGroup>{' '}
              exit git
            </span>
          </>
        ) : searchMode !== 'off' ? (
          <>
            <span>
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>{' '}
              navigate
            </span>
            <span>
              <KbdGroup>
                <Kbd>Enter</Kbd>
              </KbdGroup>{' '}
              go to
            </span>
            <span>
              <KbdGroup>
                <Kbd>^Enter</Kbd>
              </KbdGroup>{' '}
              open
            </span>
            <span>
              <KbdGroup>
                <Kbd>Tab</Kbd>
              </KbdGroup>{' '}
              {searchMode === 'files' ? 'content search' : 'file search'}
            </span>
            <span>
              <KbdGroup>
                <Kbd>Esc</Kbd>
              </KbdGroup>{' '}
              exit search
            </span>
          </>
        ) : (
          <>
            <span>
              <KbdGroup>
                <Kbd>j</Kbd>
                <Kbd>k</Kbd>
              </KbdGroup>{' '}
              navigate
            </span>
            <span>
              <KbdGroup>
                <Kbd>^n</Kbd>
                <Kbd>^p</Kbd>
              </KbdGroup>{' '}
              {focusedEntryIsDir ? `depth (${treeDepth})` : 'navigate'}
            </span>
            <span>
              <KbdGroup>
                <Kbd>Enter</Kbd>
              </KbdGroup>{' '}
              insert
            </span>
            <span>
              <KbdGroup>
                <Kbd>^Enter</Kbd>
              </KbdGroup>{' '}
              open
            </span>
            <span>
              <KbdGroup>
                <Kbd>l</Kbd>
              </KbdGroup>{' '}
              preview
            </span>
            <span>
              <KbdGroup>
                <Kbd>h</Kbd>
              </KbdGroup>{' '}
              up
            </span>
            <span>
              <KbdGroup>
                <Kbd>^d</Kbd>
                <Kbd>^u</Kbd>
              </KbdGroup>{' '}
              scroll
            </span>
            <span>
              <KbdGroup>
                <Kbd>/</Kbd>
              </KbdGroup>{' '}
              filter
            </span>
            <span>
              <KbdGroup>
                <Kbd>f</Kbd>
              </KbdGroup>{' '}
              search
            </span>
            <span>
              <KbdGroup>
                <Kbd>.</Kbd>
              </KbdGroup>{' '}
              dotfiles
            </span>
            <span>
              <KbdGroup>
                <Kbd>s</Kbd>
              </KbdGroup>{' '}
              git
            </span>
            <span>
              <KbdGroup>
                <Kbd>d</Kbd>
              </KbdGroup>{' '}
              trash
            </span>
            <span>
              <KbdGroup>
                <Kbd>D</Kbd>
              </KbdGroup>{' '}
              delete
            </span>
            <span>
              <KbdGroup>
                <Kbd>q</Kbd>
              </KbdGroup>{' '}
              close
            </span>
          </>
        )}
      </div>
    </div>
  );
}
