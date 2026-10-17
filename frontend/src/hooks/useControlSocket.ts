import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../state/store';
import { ClientMessage, NotificationLevel, ServerMessage } from '../protocol/messages';
import { windowAttended } from '../lib/windowAttention';
import { atLeast } from '../lib/notifications';
import { SYSTEM_LIGHT_QUERY, systemColorMode } from '../state/startupTheme';

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

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    // This connection's id; the server names the client that shows OS notifications.
    let clientId: number | null = null;
    // The server shows the dark or light scheme the system of the browser that
    // last reported (or was focused) prefers, while `appearance` is `auto`.
    const reportColorMode = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'system_color_mode', mode: systemColorMode() }));
      }
    };
    const reportFocus = () => {
      if (clientId != null && ws?.readyState === WebSocket.OPEN && windowAttended()) {
        ws.send(JSON.stringify({ type: 'focus_client' }));
        reportColorMode();
      }
    };
    window.addEventListener('focus', reportFocus);
    document.addEventListener('visibilitychange', reportFocus);
    const systemLight = window.matchMedia?.(SYSTEM_LIGHT_QUERY);
    systemLight?.addEventListener('change', reportColorMode);

    function connect() {
      if (disposed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/control?color_mode=${systemColorMode()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[btmux] control socket connected');
      };

      // Show an OS notification if preferences allow and this client is the target.
      const notifyOs = (
        msg: { level: NotificationLevel; body: string | null; os_client: number | null },
        title: string,
        tag?: string,
        onClick?: () => void,
      ) => {
        const prefs = useStore.getState().config?.notifications;
        const osWanted = (prefs?.os ?? true) && atLeast(msg.level, prefs?.['os-level'] ?? 'attention');
        const osTarget = msg.os_client == null || msg.os_client === clientId;
        // Some webviews (e.g. WKWebView) lack the Notification API.
        if (
          osWanted &&
          osTarget &&
          !windowAttended() &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          const notification = new Notification(title, { body: msg.body ?? undefined, tag });
          notification.onclick = () => {
            window.focus();
            onClick?.();
            notification.close();
          };
        }
        if (osWanted) offerOsNotifications(showToast);
      };

      ws.onmessage = (ev) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        if (msg.type === 'client') {
          clientId = msg.id;
          reportFocus();
        } else if (msg.type === 'state') {
          setSessions(msg.sessions);
          setAllSessions(msg.all_sessions);
          setAgentPanes(msg.agent_panes);
          setControlConnectionState('connected');
        } else if (msg.type === 'command_result') {
          if (msg.error) showToast(msg.error, 'error');
        } else if (msg.type === 'config') {
          const previous = useStore.getState().config?.version;
          setConfig(msg.config);
          // On reconnect after an upgrade or restart.
          if (previous && previous !== msg.config.version) {
            showToast(`btmux server updated to ${msg.config.version}`, 'success', { body: `Was ${previous}` });
          }
        } else if (msg.type === 'toast') {
          showToast(msg.message, msg.level);
        } else if (msg.type === 'pane_notification') {
          const away = !windowAttended();
          const paneId = msg.pane_id;
          // tag per pane so a burst from one pane coalesces into a single
          // updating banner instead of stacking N popups (renotify
          // defaults to false, so updates don't re-alert).
          notifyOs(msg, msg.title || `Agent: ${msg.event}`, `btmux-pane-${paneId}`, () =>
            useStore.getState().navigateToPane(paneId),
          );
          if (msg.level === 'attention' || msg.level === 'error') {
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
        } else if (msg.type === 'notification') {
          notifyOs(msg, msg.title);
          showToast(msg.title, msg.level, { body: msg.body ?? undefined });
        } else if (msg.type === 'focus_pane') {
          useStore.getState().navigateToPane(msg.pane_id);
        } else if (msg.type === 'open_file_browser') {
          useStore.getState().navigateToPane(msg.pane_id);
          useStore.getState().setFileBrowserOpen(true, msg.path, msg.pane_id, msg.mode, msg.focus_file);
        } else if (msg.type === 'open_nvim') {
          useStore.getState().navigateToPane(msg.pane_id);
          useStore.getState().setNvimOpen(true, msg.pane_id);
        } else if (msg.type === 'open_vscode') {
          useStore.getState().navigateToPane(msg.pane_id);
          useStore.getState().setVscodeOpen(true, msg.pane_id);
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
        clientId = null;
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
      window.removeEventListener('focus', reportFocus);
      document.removeEventListener('visibilitychange', reportFocus);
      systemLight?.removeEventListener('change', reportColorMode);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [setSessions, setAllSessions, setAgentPanes, setConfig, setControlConnectionState, showToast]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...msg, request_id: String(++nextRequestId) }));
    } else {
      useStore.getState().showToast('Connection lost. The command was not sent.', 'error');
    }
  }, []);

  return { send };
}
