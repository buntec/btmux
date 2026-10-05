import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../state/store';
import { ClientMessage, ServerMessage } from '../protocol/messages';
import { windowAttended } from '../lib/windowAttention';

let nextRequestId = 0;
let osNotificationsOffered = false;

// Browsers ignore permission requests outside a user gesture, so ask from a toast button.
function offerOsNotifications(showToast: ReturnType<typeof useStore.getState>['showToast']) {
  if (osNotificationsOffered || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  osNotificationsOffered = true;
  showToast('Enable desktop notifications?', 'info', {
    body: 'Get alerted when an agent needs you while btmux is in the background.',
    action: { label: 'Enable', run: () => void Notification.requestPermission() },
  });
}

export function useControlSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const setSessions = useStore((s) => s.setSessions);
  const setAllSessions = useStore((s) => s.setAllSessions);
  const setAgentPanes = useStore((s) => s.setAgentPanes);
  const setConfig = useStore((s) => s.setConfig);
  const setControlConnectionState = useStore((s) => s.setControlConnectionState);
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
      };

      ws.onmessage = (ev) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        if (msg.type === 'state') {
          setSessions(msg.sessions);
          setAllSessions(msg.all_sessions);
          setAgentPanes(msg.agent_panes);
          setControlConnectionState('connected');
        } else if (msg.type === 'command_result') {
          if (msg.error) showToast(msg.error, 'error');
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
            const away = !windowAttended();
            // Some webviews (e.g. WKWebView) lack the Notification API.
            if (away && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              // tag per pane so a burst from one pane coalesces into a single
              // updating banner instead of stacking N popups (renotify
              // defaults to false, so updates don't re-alert).
              const notification = new Notification(msg.title || `Agent: ${msg.event}`, {
                body: msg.body ?? undefined,
                tag: `btmux-pane-${msg.pane_id}`,
              });
              const paneId = msg.pane_id;
              notification.onclick = () => {
                window.focus();
                useStore.getState().navigateToPane(paneId);
                notification.close();
              };
            }
            offerOsNotifications(showToast);
            // Show an in-app toast unless the user is looking at the notified pane.
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
            if (away || msg.pane_id !== focusedPaneId) {
              const label = msg.title || msg.event;
              showToast(label, msg.level, {
                body: msg.body ?? undefined,
                paneId: msg.pane_id,
              });
            }
          }
        } else if (msg.type === 'pane_notification_clear') {
          clearPaneNotification(msg.pane_id);
        } else if (msg.type === 'open_file_browser') {
          useStore.getState().navigateToPane(msg.pane_id);
          useStore.getState().setFileBrowserOpen(true, msg.path, msg.pane_id, msg.mode, msg.focus_file);
        }
      };

      ws.onerror = (ev) => {
        console.error('[btmux] control socket error:', ev);
      };

      ws.onclose = () => {
        if (!disposed)
          fetch('/api/sessions', { cache: 'no-store' })
            .then((response) => {
              if (!disposed && response.status === 401) window.dispatchEvent(new Event('btmux-auth-required'));
            })
            .catch(() => {});
        wsRef.current = null;
        setControlConnectionState('reconnecting');
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
    setAgentPanes,
    setConfig,
    setControlConnectionState,
    showToast,
    setPaneNotification,
    clearPaneNotification,
  ]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...msg, request_id: String(++nextRequestId) }));
    } else {
      useStore.getState().showToast('Connection lost. The command was not sent.', 'error');
    }
  }, []);

  return { send };
}
