import { useNavigate, useParams } from 'react-router-dom';
import { useEffect, useCallback, useRef } from 'react';
import { useStore } from '../state/store';
import { useKeybindings } from '../hooks/useKeybindings';
import { ClientMessage } from '../protocol/messages';

interface Props {
  send: (msg: ClientMessage) => void;
}

/**
 * The route component for /s/:sessionName[/w/:windowName]. It renders no
 * terminals: the keep-alive pool lives in SessionPool (mounted above the router
 * so it survives navigation), and StatusBar/Overlay are single instances in
 * AppInner. SessionView exists purely for its route-driven effects — keeping the
 * URL in sync with the active window, switching to the URL's window on entry,
 * redirecting to the landing page if the session was killed — plus binding
 * keyboard shortcuts to the active session. These must stay in the route-mounted
 * component (not SessionPool, which never remounts) so e.g. initialWindowSwitch
 * fires once per route entry.
 */
export function SessionView({ send }: Props) {
  const { sessionName, windowName } = useParams<{
    sessionName: string;
    windowName: string;
  }>();
  const navigate = useNavigate();
  const allSessions = useStore((s) => s.allSessions);

  const decodedSessionName = sessionName ? decodeURIComponent(sessionName) : '';
  const session = allSessions.find((s) => s.name === decodedSessionName);

  // If the session was killed, redirect to landing
  useEffect(() => {
    if (allSessions.length > 0 && !session) {
      navigate('/', { replace: true });
    }
  }, [session, allSessions.length, navigate]);

  // On first mount with a windowName param, switch to that window if it isn't active.
  const initialWindowSwitchDone = useRef(false);
  useEffect(() => {
    if (initialWindowSwitchDone.current || !session || !windowName) {
      initialWindowSwitchDone.current = true;
      return;
    }
    initialWindowSwitchDone.current = true;
    const decoded = decodeURIComponent(windowName);
    const winIdx = session.windows.findIndex((w) => w.name === decoded);
    if (winIdx >= 0 && winIdx !== session.active_window) {
      send({ type: 'switch_window', session_id: session.id, index: winIdx });
    }
  }, [session, windowName, send]);

  // Keep the URL in sync with the active window (rename, switch, etc.)
  const activeWindowName = session?.windows[session?.active_window]?.name ?? null;
  useEffect(() => {
    if (!session || !activeWindowName) return;
    const target = `/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(activeWindowName)}`;
    if (window.location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [session?.active_window, activeWindowName, session?.name, navigate]);

  const goToLanding = useCallback(() => navigate('/'), [navigate]);
  const switchToSession = useCallback(
    (name: string) => {
      const target = allSessions.find((s) => s.name === name);
      if (!target) return;
      const activeWin = target.windows[target.active_window];
      const url = activeWin
        ? `/s/${encodeURIComponent(target.name)}/w/${encodeURIComponent(activeWin.name)}`
        : `/s/${encodeURIComponent(target.name)}`;
      navigate(url);
    },
    [allSessions, navigate],
  );
  useKeybindings(session?.id ?? '', send, goToLanding, switchToSession);

  // Renders nothing: the terminal grid (SessionPool), StatusBar and Overlay are
  // owned by AppInner so they persist across session switches. SessionView is an
  // effects-only route component.
  return null;
}
