import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { SessionPane } from './SessionPane';

interface Props {
  send: (msg: ClientMessage) => void;
}

/**
 * The cross-session keep-alive pool. SessionPool is mounted once in AppInner,
 * *above* <Routes>, so it never unmounts on navigation — that's what lets a
 * session's terminals survive even a trip through the landing page (the
 * choose-tree path unmounts SessionView). It keeps the last POOL_LIMIT sessions
 * warm: each pooled session gets a SessionPane (keyed by sessionId) whose ghostty
 * terminals and pane sockets stay mounted; only the active session's is shown,
 * the rest are display:none + suspend()ed but still streaming. Switching back to
 * a pooled session is then instant — no teardown, no reconnect, no scrollback
 * replay — exactly the keep-mounted pattern SessionPane uses for the windows
 * within one session, lifted one level up to sessions.
 */
const POOL_LIMIT = 4;

export function SessionPool({ send }: Props) {
  const allSessions = useStore((s) => s.allSessions);
  const location = useLocation();

  // The active session is derived purely from the URL (there is no server-side
  // "current session"). Mirrors the regex AppInner uses. On the landing page
  // ("/") nothing is active, so no SessionPane is shown — but the pool is left
  // untouched, keeping the last-N sessions warm while you browse the tree.
  const match = location.pathname.match(/^\/s\/([^/]+)/);
  const activeSessionName = match ? decodeURIComponent(match[1]) : null;
  const activeSessionId = allSessions.find((s) => s.name === activeSessionName)?.id ?? null;

  // LRU membership: sessionIds, most-recently-active first, capped at POOL_LIMIT.
  // Seed synchronously from the initial URL so the first paint already has the
  // active session's SessionPane mounted (the add-on-activation effect below
  // runs after paint, which would otherwise flash an empty pane region on load).
  // SessionPool only mounts once allSessions is populated (App's connecting gate).
  const [pool, setPool] = useState<string[]>(() => (activeSessionId ? [activeSessionId] : []));

  // Promote the active session to the front and evict beyond the cap. This is
  // the only place the pool grows. Navigating to "/" leaves activeSessionId null
  // and so leaves the pool as-is, which is what keeps choose-tree switch-backs
  // instant. Evicting an id simply drops its SessionPane from the render below,
  // which unmounts it and disposes its terminals + closes its sockets.
  useEffect(() => {
    if (!activeSessionId) return;
    setPool((prev) => [activeSessionId, ...prev.filter((id) => id !== activeSessionId)].slice(0, POOL_LIMIT));
  }, [activeSessionId]);

  // Drop pool entries for sessions the server has killed, so a dead session
  // doesn't permanently occupy an LRU slot. The length guard prevents a
  // set-state loop. Rendering also filters (below), so this is housekeeping only.
  useEffect(() => {
    setPool((prev) => {
      const next = prev.filter((id) => allSessions.some((s) => s.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [allSessions]);

  return (
    <>
      {pool
        .filter((id) => allSessions.some((s) => s.id === id))
        .map((id) => (
          <SessionPane key={id} sessionId={id} isActiveSession={id === activeSessionId} send={send} />
        ))}
    </>
  );
}
