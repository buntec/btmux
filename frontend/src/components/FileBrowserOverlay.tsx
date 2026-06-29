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
import { getParent } from '@/lib/utils';
import type { FileEntry, FileContent, GitStatusResult, FileDiff, TreeNode } from '@/protocol/file-messages';
import type { ClientMessage } from '@/protocol/messages';

const MEDIA_EXTENSIONS = new Set([
  'pdf', 'mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma',
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
  const gitStatus = useFileStore((s) => s.gitStatus);
  const gitFocusedIndex = useFileStore((s) => s.gitFocusedIndex);
  const gitExpandedSections = useFileStore((s) => s.gitExpandedSections);
  const store = useFileStore;
  const initialized = useRef(false);
  const gitPreviewGenRef = useRef(0);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const dragging = useRef(false);

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
    async (path: string) => {
      store.getState().setIsLoading(true);
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      store.getState().setDirectoryTree(null);
      try {
        const resp = await fileSend('list_dir', { root: path, path: '.' });
        const payload = resp.payload as { path: string; entries: FileEntry[] };
        store.getState().setCurrentPath(payload.path);
        store.getState().setEntries(payload.entries);
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
    async (path: string) => {
      store.getState().setSelectedFile(null);
      store.getState().setFileContent(null);
      try {
        const resp = await fileSend('list_tree', { root: path, path: '.', max_depth: 4, max_items: 15 });
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

  const gitStage = useCallback(async (path: string) => {
    try {
      const resp = await fileSend('git_stage', { path, cwd: currentPath });
      const payload = resp.payload as { status: GitStatusResult };
      store.getState().setGitStatus(payload.status);
    } catch (e) {
      console.error('git_stage failed:', e);
    }
  }, [fileSend, currentPath, store]);

  const gitUnstage = useCallback(async (path: string) => {
    try {
      const resp = await fileSend('git_unstage', { path, cwd: currentPath });
      const payload = resp.payload as { status: GitStatusResult };
      store.getState().setGitStatus(payload.status);
    } catch (e) {
      console.error('git_unstage failed:', e);
    }
  }, [fileSend, currentPath, store]);

  const gitDiscard = useCallback(async (path: string) => {
    try {
      const resp = await fileSend('git_discard', { path, cwd: currentPath });
      const payload = resp.payload as { status: GitStatusResult };
      store.getState().setGitStatus(payload.status);
    } catch (e) {
      console.error('git_discard failed:', e);
    }
  }, [fileSend, currentPath, store]);

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
    const sessions = mainStore.allSessions;
    for (const session of sessions) {
      const win = session.windows[session.active_window];
      if (!win) continue;
      const pane = win.panes[win.active_pane];
      if (pane) return { sessionId: session.id, paneId: pane.id };
    }
    return null;
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

  // Auto-preview focused entry (file or directory)
  useEffect(() => {
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
      selectDir(fullPath);
    } else {
      selectFile(fullPath, false);
    }
  }, [focusedIndex, entries, currentPath, showDotFiles, isFilterActive, filterQuery, selectFile, selectDir]);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (isFilterActive) {
          store.getState().setIsFilterActive(false);
        } else if (isGitMode) {
          store.getState().setIsGitMode(false);
          store.getState().setGitDiff(null);
        } else {
          onClose();
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
            const fullPath =
              currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
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
        store.getState().setFocusedIndex(Math.min(focusedIndex + 1, visible.length - 1));
        return;
      }
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        store.getState().setFocusedIndex(Math.max(focusedIndex - 1, 0));
        return;
      }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        const viewport = document.querySelector(
          '.file-preview-scroll [data-slot="scroll-area-viewport"]',
        );
        if (viewport) viewport.scrollBy({ top: viewport.clientHeight / 2 });
        return;
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        const viewport = document.querySelector(
          '.file-preview-scroll [data-slot="scroll-area-viewport"]',
        );
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
          const fullPath =
            currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
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
          const fullPath =
            currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          if (entry.is_dir) {
            navigate(fullPath);
          } else {
            selectFile(fullPath, false);
          }
          break;
        }
        case 'h':
        case 'ArrowLeft':
        case 'Backspace':
          e.preventDefault();
          navigate(getParent(currentPath));
          break;
        case '/':
          e.preventDefault();
          store.getState().setIsFilterActive(true);
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
    navigate,
    selectFile,
    insertPath,
    openPath,
    onClose,
    toggleGitMode,
    gitStage,
    gitUnstage,
    gitDiscard,
    store,
  ]);

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
        <div
          className="shrink-0 flex flex-col min-h-0 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          {isGitMode ? (
            <>
              <GitModeHeader />
              <GitStatus />
            </>
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
        {isGitMode ? (
          <>
            <span>j/k navigate</span>
            <span>Tab expand/collapse</span>
            <span>s stage</span>
            <span>u unstage</span>
            <span>x discard</span>
            <span>Esc exit git</span>
          </>
        ) : (
          <>
            <span>j/k/^n/^p navigate</span>
            <span>Enter insert path</span>
            <span>Ctrl+Enter open/cd</span>
            <span>l preview</span>
            <span>h/Backspace up</span>
            <span>^d/^u scroll</span>
            <span>/ filter</span>
            <span>. dotfiles</span>
            <span>s git</span>
            <span>Esc close</span>
          </>
        )}
      </div>
    </div>
  );
}
