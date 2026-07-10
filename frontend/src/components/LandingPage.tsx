import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { buildTreeNodes } from '../state/treeNodes';
import { TreeNode } from '../state/types';
import { recordSessionMruVisit, sortSessions } from '../state/sessionMru';

export { recordSessionMruVisit as recordMruVisit };

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
}

interface Props {
  send: (msg: ClientMessage) => void;
  currentSessionId: string | null;
}

function sessionWindowUrl(sessionName: string, windowName: string): string {
  return `/s/${encodeURIComponent(sessionName)}/w/${encodeURIComponent(windowName)}`;
}

/**
 * tmux-style choose-tree key tags: index 0-9 → "0".."9", then 10-35 → "M-a".."M-z"
 * (Meta + a letter, since digits run out at 9). Returns null past 35 — those
 * sessions have no hotkey and are reached by cursor/search only.
 */
function sessionKeyTag(index: number): string | null {
  if (index < 10) return String(index);
  const letter = index - 10;
  if (letter < 26) return `M-${String.fromCharCode(97 + letter)}`;
  return null;
}

/** Inverse of sessionKeyTag for a keydown event: digit, or Alt+letter via e.code. */
function sessionIndexForKey(e: React.KeyboardEvent): number | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (!e.altKey && e.key >= '0' && e.key <= '9') return parseInt(e.key, 10);
  // Alt+letter: match the physical key (e.code) because macOS Option composes
  // accented chars into e.key, so e.key would no longer be a plain "a".
  if (e.altKey) {
    const m = /^Key([A-Z])$/.exec(e.code);
    if (m) return 10 + (m[1].charCodeAt(0) - 65);
  }
  return null;
}

function navigateToNode(
  node: TreeNode,
  allNodes: TreeNode[],
  send: (msg: ClientMessage) => void,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (node.kind === 'session') {
    const activeWin = allNodes.find((n) => n.kind === 'window' && n.sessionId === node.id && n.active) as
      | Extract<TreeNode, { kind: 'window' }>
      | undefined;
    const url = activeWin ? sessionWindowUrl(node.name, activeWin.name) : `/s/${encodeURIComponent(node.name)}`;
    navigate(url);
  } else if (node.kind === 'window') {
    send({
      type: 'switch_window',
      session_id: node.sessionId,
      index: node.index,
    });
    navigate(sessionWindowUrl(node.sessionName, node.name));
  } else {
    const winNode = allNodes.find((n) => n.kind === 'window' && n.id === node.windowId) as
      | Extract<TreeNode, { kind: 'window' }>
      | undefined;
    if (winNode)
      send({
        type: 'switch_window',
        session_id: node.sessionId,
        index: winNode.index,
      });
    send({ type: 'select_pane', session_id: node.sessionId, pane_id: node.id });
    const winName = winNode?.name ?? '';
    navigate(sessionWindowUrl(node.sessionName, winName));
  }
}

function computeVisibleNodes(
  allNodes: TreeNode[],
  expandedSessions: Set<string>,
  expandedWindows: Set<string>,
): TreeNode[] {
  return allNodes.filter((node) => {
    if (node.kind === 'session') return true;
    if (node.kind === 'window') return expandedSessions.has(node.sessionId);
    return expandedWindows.has(node.windowId);
  });
}

export function LandingPage({ send, currentSessionId }: Props) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const setOverlay = useStore((s) => s.setOverlay);
  const navigate = useNavigate();
  const fontSize = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));

  const sortedSessions = sortSessions(allSessions, config?.session_sort ?? 'created');
  const allNodes = buildTreeNodes(sortedSessions, currentSessionId);
  // tmux-style session numbers: a session's position in the (sorted) list. The
  // number is shown on each session row, and a bare digit 0-9 jumps to it (see
  // onKeyDown). Numbers track the displayed order, so they follow session_sort.
  const sessionNumbers = new Map(sortedSessions.map((s, i) => [s.id, i]));

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedWindows, setExpandedWindows] = useState<Set<string>>(new Set());

  // Incremental search (tmux-style): '/' enters search mode, typing filters the
  // tree to sessions whose name matches. While searching, printable keys edit the
  // query; Arrow Up/Down move the selection; Enter jumps; Escape cancels.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const query = searchQuery.trim().toLowerCase();
  const matchedSessionIds = query
    ? new Set(sortedSessions.filter((s) => s.name.toLowerCase().includes(query)).map((s) => s.id))
    : null;

  const visibleNodes = computeVisibleNodes(allNodes, expandedSessions, expandedWindows).filter((node) =>
    !matchedSessionIds ? true : matchedSessionIds.has(node.kind === 'session' ? node.id : node.sessionId),
  );

  // Start cursor on the current session row (tree is collapsed by default)
  const initialIdx = Math.max(
    0,
    allNodes.filter((n) => n.kind === 'session').findIndex((n) => n.id === currentSessionId),
  );
  const [selectedIdx, setSelectedIdx] = useState(initialIdx);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const overlay = useStore((s) => s.overlay);
  useEffect(() => {
    if (!overlay) containerRef.current?.focus();
  }, [overlay]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Clamp selectedIdx if tree changes (e.g. session killed)
  const clampedIdx = Math.min(selectedIdx, Math.max(0, visibleNodes.length - 1));

  const theme = config?.theme;
  const bg = theme?.background ?? DEFAULT_THEME.background;
  const fg = theme?.foreground ?? DEFAULT_THEME.foreground;
  const dimFg = theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const activeFg = theme?.green ?? DEFAULT_THEME.green;
  const accentFg = theme?.yellow ?? DEFAULT_THEME.yellow;
  const selBg = theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;
  const winFg = theme?.white ?? DEFAULT_THEME.white;

  const exitSearch = () => {
    setSearchMode(false);
    setSearchQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();

    // Search mode: printable keys edit the query; only arrows move the cursor
    // (j/k/h/l are reserved for typing). Enter jumps, Escape cancels.
    if (searchMode) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitSearch();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const node = visibleNodes[clampedIdx];
        if (node) navigateToNode(node, allNodes, send, navigate);
        return;
      }
      const sDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const sUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      if (sDown || sUp) {
        e.preventDefault();
        const n = visibleNodes.length;
        if (n === 0) return;
        setSelectedIdx((i) => (i + (sDown ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setSearchQuery((q) => q.slice(0, -1));
        setSelectedIdx(0);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setSearchQuery((q) => q + e.key);
        setSelectedIdx(0);
        return;
      }
      return;
    }

    const down = e.key === 'ArrowDown' || e.key === 'j' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || e.key === 'k' || (e.ctrlKey && e.key === 'p');
    const right = e.key === 'ArrowRight' || e.key === 'l';
    const left = e.key === 'ArrowLeft' || e.key === 'h';

    if (e.key === '/') {
      e.preventDefault();
      setSearchMode(true);
      setSearchQuery('');
      setSelectedIdx(0);
      return;
    }

    // tmux-style hotkey jump to a session: digit 0-9, then Alt+a..z for 10-35.
    const sessNum = sessionIndexForKey(e);
    if (sessNum !== null) {
      e.preventDefault();
      const target = sortedSessions[sessNum];
      if (target) {
        const sessNode = allNodes.find((n) => n.kind === 'session' && n.id === target.id);
        if (sessNode) navigateToNode(sessNode, allNodes, send, navigate);
      }
      return;
    }

    if (down || up) {
      e.preventDefault();
      const n = visibleNodes.length;
      if (n === 0) return;
      setSelectedIdx((i) => (i + (down ? 1 : -1) + n) % n);
      return;
    }

    if (right) {
      e.preventDefault();
      const node = visibleNodes[clampedIdx];
      if (!node) return;
      if (node.kind === 'session') {
        const newExpanded = new Set(expandedSessions);
        newExpanded.add(node.id);
        setExpandedSessions(newExpanded);
        const newVisible = computeVisibleNodes(allNodes, newExpanded, expandedWindows);
        const firstWinIdx = newVisible.findIndex((n) => n.kind === 'window' && n.sessionId === node.id);
        if (firstWinIdx >= 0) setSelectedIdx(firstWinIdx);
      } else if (node.kind === 'window') {
        const newExpanded = new Set(expandedWindows);
        newExpanded.add(node.id);
        setExpandedWindows(newExpanded);
        const newVisible = computeVisibleNodes(allNodes, expandedSessions, newExpanded);
        const firstPaneIdx = newVisible.findIndex((n) => n.kind === 'pane' && n.windowId === node.id);
        if (firstPaneIdx >= 0) setSelectedIdx(firstPaneIdx);
      }
      return;
    }

    if (left) {
      e.preventDefault();
      const node = visibleNodes[clampedIdx];
      if (!node) return;
      if (node.kind === 'pane') {
        const parentIdx = visibleNodes.findIndex((n) => n.kind === 'window' && n.id === node.windowId);
        setExpandedWindows((prev) => {
          const next = new Set(prev);
          next.delete(node.windowId);
          return next;
        });
        if (parentIdx >= 0) setSelectedIdx(parentIdx);
      } else if (node.kind === 'window') {
        const parentIdx = visibleNodes.findIndex((n) => n.kind === 'session' && n.id === node.sessionId);
        // Clean up expanded windows for this session so re-expanding shows collapsed windows
        setExpandedWindows((prev) => {
          const next = new Set(prev);
          allNodes.forEach((n) => {
            if (n.kind === 'window' && n.sessionId === node.sessionId) next.delete(n.id);
          });
          return next;
        });
        setExpandedSessions((prev) => {
          const next = new Set(prev);
          next.delete(node.sessionId);
          return next;
        });
        if (parentIdx >= 0) setSelectedIdx(parentIdx);
      }
      // h on session: no-op (already at top level)
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const node = visibleNodes[clampedIdx];
      if (node) navigateToNode(node, allNodes, send, navigate);
      return;
    }

    if (e.key === 'c' || e.key === 'n') {
      e.preventDefault();
      setOverlay({
        mode: 'prompt',
        title: 'new-session',
        value: '',
        action: 'new-session',
      });
      return;
    }

    if (e.key === 'x') {
      e.preventDefault();
      const node = visibleNodes[clampedIdx];
      if (!node) return;
      if (node.kind === 'session') {
        setOverlay({
          mode: 'confirm',
          title: `kill session "${node.name}"?`,
          onConfirm: () => send({ type: 'kill_session', id: node.id }),
        });
      } else if (node.kind === 'window') {
        setOverlay({
          mode: 'confirm',
          title: `kill window "${node.name}"?`,
          onConfirm: () => send({ type: 'kill_window', window_id: node.id }),
        });
      } else {
        setOverlay({
          mode: 'confirm',
          title: 'kill pane?',
          onConfirm: () =>
            send({
              type: 'kill_pane',
              session_id: node.sessionId,
              pane_id: node.id,
            }),
        });
      }
      return;
    }

    if (e.key === 'Escape' && currentSessionId) {
      e.preventDefault();
      const currentSession = allSessions.find((s) => s.id === currentSessionId);
      if (currentSession) {
        const activeWin = currentSession.windows[currentSession.active_window];
        if (activeWin) navigate(sessionWindowUrl(currentSession.name, activeWin.name));
        else navigate(`/s/${encodeURIComponent(currentSession.name)}`);
      }
      return;
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: `rgba(${hexToRgb(bg)}, 0.50)`,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        color: fg,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        fontSize: `${fontSize}px`,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 16px',
          borderBottom: `1px solid ${selBg}`,
          color: accentFg,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>btmux{config?.version ? ` v${config.version}` : ''}</span>
        <span style={{ color: dimFg, fontSize: `${Math.max(6, fontSize - 2)}px` }}>
          j/k ↑/↓ navigate · l/h →/← expand/collapse · enter select · (0-9)/(M-a…) jump · / search · n/c new · x kill
          {currentSessionId ? ' · esc back' : ''}
        </span>
      </div>

      {/* Tree */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{
          flex: 1,
          outline: 'none',
          overflowY: 'auto',
          padding: '8px 0',
        }}
      >
        {visibleNodes.length === 0 && (
          <div style={{ color: dimFg, padding: '8px 16px' }}>
            {query ? `No sessions matching "${searchQuery.trim()}".` : 'No sessions. Press n to create one.'}
          </div>
        )}
        {visibleNodes.map((node, i) => {
          const isSelected = i === clampedIdx;
          let indent: number;
          let prefix: string;
          let label: string;
          let color: string;

          if (node.kind === 'session') {
            indent = 0;
            const arrow = expandedSessions.has(node.id) ? '▾' : '▸';
            const tag = sessionKeyTag(sessionNumbers.get(node.id) ?? 0);
            prefix = tag ? `${arrow} (${tag}) ` : `${arrow} `;
            label = node.name;
            color = node.id === currentSessionId ? activeFg : fg;
          } else if (node.kind === 'window') {
            indent = 16;
            const arrow = expandedWindows.has(node.id) ? '▾' : '▸';
            prefix = `${arrow} ${node.index}: `;
            label = node.name + (node.active ? ' *' : '');
            color = node.active ? winFg : fg;
          } else {
            indent = 32;
            prefix = `[${node.index}] `;
            const cwdShort = node.cwd ? node.cwd.replace(/^.*\//, '') || node.cwd : null;
            label = (node.title || cwdShort || 'pane') + (node.active ? ' *' : '');
            color = dimFg;
          }

          return (
            <div
              key={`${node.kind}-${node.id}`}
              ref={isSelected ? selectedRef : null}
              onClick={() => {
                setSelectedIdx(i);
                navigateToNode(node, allNodes, send, navigate);
              }}
              style={{
                padding: `1px 16px 1px ${16 + indent}px`,
                cursor: 'pointer',
                background: isSelected ? selBg : 'transparent',
                color,
                userSelect: 'none',
              }}
            >
              <span style={{ opacity: 0.5 }}>{prefix}</span>
              {label}
            </div>
          );
        })}
      </div>

      {/* Search bar (tmux-style), shown only while searching */}
      {searchMode && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '4px 16px',
            borderTop: `1px solid ${selBg}`,
            color: fg,
          }}
        >
          <span style={{ color: accentFg, marginRight: '8px' }}>/</span>
          <span>{searchQuery}</span>
          <span style={{ color: accentFg }}>▏</span>
          <span style={{ marginLeft: 'auto', color: dimFg, fontSize: `${Math.max(6, fontSize - 2)}px` }}>
            ↑/↓ C-n/C-p select · enter open · esc cancel
          </span>
        </div>
      )}
    </div>
  );
}
