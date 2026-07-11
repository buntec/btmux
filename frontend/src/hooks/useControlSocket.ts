import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../state/store';
import { ClientMessage, ServerMessage } from '../protocol/messages';

export function useControlSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const setSessions = useStore((s) => s.setSessions);
  const setAllSessions = useStore((s) => s.setAllSessions);
  const setConfig = useStore((s) => s.setConfig);
  const setControlConnected = useStore((s) => s.setControlConnected);
  const showToast = useStore((s) => s.showToast);
  const setPaneNotification = useStore((s) => s.setPaneNotification);
  const clearPaneNotification = useStore((s) => s.clearPaneNotification);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/control`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[btmux] control socket connected');
        setControlConnected(true);
      };

      ws.onmessage = (ev) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        if (msg.type === 'state') {
          setSessions(msg.sessions);
          setAllSessions(msg.all_sessions);
        } else if (msg.type === 'config') {
          setConfig(msg.config);
        } else if (msg.type === 'toast') {
          showToast(msg.message, msg.level);
        } else if (msg.type === 'pane_notification') {
          setPaneNotification({
            paneId: msg.pane_id,
            event: msg.event,
            level: msg.level,
            title: msg.title,
            body: msg.body,
            timestamp: Date.now(),
          });
          if (msg.level === 'attention' || msg.level === 'error') {
            if (document.hidden) {
              const title = msg.title || `Claude Code: ${msg.event}`;
              if (Notification.permission === 'granted') {
                // tag per pane so a burst from one pane coalesces into a single
                // updating banner instead of stacking N popups (renotify
                // defaults to false, so updates don't re-alert).
                const notification = new Notification(title, {
                  body: msg.body ?? undefined,
                  tag: `btmux-pane-${msg.pane_id}`,
                });
                const paneId = msg.pane_id;
                notification.onclick = () => {
                  window.focus();
                  useStore.getState().navigateToPane(paneId);
                  notification.close();
                };
              } else if (Notification.permission !== 'denied') {
                Notification.requestPermission();
              }
            }
            // Show an in-app toast unless the notified pane is currently focused.
            const state = useStore.getState();
            const match = window.location.pathname.match(/^\/s\/([^/]+)/);
            const activeSessionName = match ? decodeURIComponent(match[1]) : null;
            const activeSession = activeSessionName
              ? state.allSessions.find((s) => s.name === activeSessionName)
              : null;
            const focusedPaneId = activeSession
              ? activeSession.windows[activeSession.active_window]?.panes[
                  activeSession.windows[activeSession.active_window]?.active_pane
                ]?.id
              : null;
            if (msg.pane_id !== focusedPaneId) {
              const label = msg.title || msg.event;
              showToast(label, msg.level, {
                body: msg.body ?? undefined,
                paneId: msg.pane_id,
              });
            }
          }
        } else if (msg.type === 'pane_notification_clear') {
          clearPaneNotification(msg.pane_id);
        }
      };

      ws.onerror = (ev) => {
        console.error('[btmux] control socket error:', ev);
      };

      ws.onclose = () => {
        wsRef.current = null;
        setControlConnected(false);
        if (!disposed) {
          console.log('[btmux] control socket closed, reconnecting in 2s...');
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [
    setSessions,
    setAllSessions,
    setConfig,
    setControlConnected,
    showToast,
    setPaneNotification,
    clearPaneNotification,
  ]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
