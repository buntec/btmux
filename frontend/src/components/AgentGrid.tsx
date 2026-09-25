import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { DEFAULT_THEME } from '../state/defaultTheme';
import type { AgentStatus } from '../state/types';
import { AgentStatusBadge } from './PaneTitleBar';
import { MirrorPane } from './MirrorPane';

interface Props {
  send: (msg: ClientMessage) => void;
}

interface AgentPaneEntry {
  sessionId: string;
  sessionName: string;
  windowName: string;
  windowIndex: number;
  paneId: string;
  paneIndex: number;
  paneTitle: string | null;
  agentStatus: AgentStatus;
}

function buildEntries(
  allSessions: ReturnType<typeof useStore.getState>['allSessions'],
  activePaneIds: Set<string>,
): AgentPaneEntry[] {
  const entries: AgentPaneEntry[] = [];
  for (const session of allSessions) {
    session.windows.forEach((win, windowIndex) => {
      win.panes.forEach((pane, paneIndex) => {
        if (!activePaneIds.has(pane.id)) return;
        entries.push({
          sessionId: session.id,
          sessionName: session.name,
          windowName: win.name,
          windowIndex,
          paneId: pane.id,
          paneIndex,
          paneTitle: pane.title,
          agentStatus: pane.agent_status,
        });
      });
    });
  }
  return entries;
}

/** Full-screen live mirrors of panes with detected or reported agents. */
export function AgentGrid({ send }: Props) {
  const open = useStore((s) => s.agentGridOpen);
  const mounted = useStore((s) => s.agentGridMounted);
  const setOpen = useStore((s) => s.setAgentGridOpen);
  const allSessions = useStore((s) => s.allSessions);
  const agentPanes = useStore((s) => s.agentPanes);
  const config = useStore((s) => s.config);
  const location = useLocation();
  const navigate = useNavigate();
  const entries = useMemo(() => buildEntries(allSessions, agentPanes), [allSessions, agentPanes]);

  const [mirrorsReady, setMirrorsReady] = useState(false);
  const hasEverBeenReady = useRef(false);
  useEffect(() => {
    if (open && !hasEverBeenReady.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMirrorsReady(true);
          hasEverBeenReady.current = true;
        });
      });
    }
  }, [open]);

  const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.max(1, Math.ceil(entries.length / cols));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      const match = location.pathname.match(/^\/s\/([^/]+)/);
      const sessionName = match ? decodeURIComponent(match[1]) : null;
      const session = sessionName ? allSessions.find((s) => s.name === sessionName) : null;
      const activeWindow = session?.windows[session.active_window];
      const activePaneId = activeWindow?.panes[activeWindow.active_pane]?.id;
      const idx = activePaneId ? entries.findIndex((entry) => entry.paneId === activePaneId) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
      containerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, entries, location.pathname, allSessions]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, entries.length - 1));

  const cancel = () => {
    setOpen(false);
    const prev = prevFocusRef.current;
    if (prev && prev.isConnected) {
      window.setTimeout(() => {
        if (prev.isConnected) prev.focus();
      }, 0);
    }
  };

  const select = (entry: AgentPaneEntry | undefined) => {
    if (!entry) return;
    send({ type: 'switch_window', session_id: entry.sessionId, index: entry.windowIndex });
    send({ type: 'select_pane', session_id: entry.sessionId, pane_id: entry.paneId });
    const session = allSessions.find((item) => item.id === entry.sessionId);
    navigate(`/s/${encodeURIComponent(session?.name ?? entry.sessionName)}/w/${encodeURIComponent(entry.windowName)}`);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const n = entries.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (n === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      select(entries[clampedIdx]);
      return;
    }
    const right = e.key === 'ArrowRight' || e.key === 'l';
    const left = e.key === 'ArrowLeft' || e.key === 'h';
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (right || left || down || up) {
      e.preventDefault();
      const delta = right ? 1 : left ? -1 : down ? cols : -cols;
      setSelectedIdx((i) => Math.max(0, Math.min(n - 1, i + delta)));
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1;
      if (idx < n) {
        e.preventDefault();
        setSelectedIdx(idx);
      }
    }
  };

  if (!mounted) return null;

  const theme = config?.theme;
  const bg = theme?.background ?? DEFAULT_THEME.background;
  const dimFg = theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const ringColor = theme?.blue ?? DEFAULT_THEME.blue;
  const cellBorder = theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        inset: 0,
        display: open ? 'grid' : 'none',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(160px, 1fr))`,
        gap: '8px',
        padding: '8px',
        background: bg,
        outline: 'none',
        overflow: 'auto',
        zIndex: 31,
        boxSizing: 'border-box',
        fontFamily: 'var(--btmux-font)',
        fontWeight: 'var(--btmux-font-weight)',
      }}
    >
      {entries.length === 0 && (
        <div style={{ color: dimFg, padding: '16px', gridColumn: '1 / -1' }}>
          No agents detected. Install agent hooks for status and notifications.
        </div>
      )}
      {entries.map((entry, i) => {
        const isSelected = i === clampedIdx;
        return (
          <div
            key={entry.paneId}
            onClick={() => select(entry)}
            style={{
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              cursor: 'pointer',
              border: `2px solid ${isSelected ? ringColor : cellBorder}`,
              boxShadow: isSelected ? `0 0 0 2px ${ringColor}` : undefined,
              boxSizing: 'border-box',
              background: bg,
            }}
          >
            <div style={{ position: 'absolute', inset: 0, paddingBottom: '26px', boxSizing: 'border-box' }}>
              {mirrorsReady && <MirrorPane paneId={entry.paneId} visible={open} />}
            </div>
            <AgentStatusBadge theme={theme ?? null} status={entry.agentStatus} overlay />
            <div
              style={{
                position: 'absolute',
                insetInline: 0,
                bottom: 0,
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0 8px',
                boxSizing: 'border-box',
                background: bg,
                color: theme?.foreground ?? DEFAULT_THEME.foreground,
                fontSize: '12px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                zIndex: 2,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.sessionName} / {entry.windowName}
              </span>
              <span style={{ color: dimFg, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.paneTitle || `pane ${entry.paneIndex + 1}`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
