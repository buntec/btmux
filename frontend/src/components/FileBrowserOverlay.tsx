import { useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { useFileSocket } from '@/hooks/useFileSocket';
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';
import { FileTree } from './files/FileTree';
import { FilePreview } from './files/FilePreview';
import { Breadcrumb } from './files/Breadcrumb';
import { getParent } from '@/lib/utils';
import type { FileEntry, FileContent, TreeNode } from '@/protocol/file-messages';
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
  const store = useFileStore;
  const initialized = useRef(false);

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
        } else {
          onClose();
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
    navigate,
    selectFile,
    insertPath,
    openPath,
    onClose,
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
        <div className="w-64 border-r border-border flex flex-col min-h-0">
          <FileTree onNavigate={navigate} onSelect={selectFile} />
        </div>
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
        <span>j/k/^n/^p navigate</span>
        <span>Enter insert path</span>
        <span>Ctrl+Enter open/cd</span>
        <span>l preview</span>
        <span>h/Backspace up</span>
        <span>^d/^u scroll</span>
        <span>/ filter</span>
        <span>. dotfiles</span>
        <span>Esc close</span>
      </div>
    </div>
  );
}
