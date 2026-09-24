import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '../lib/connectionState';
import type { ProcessServerMessage } from '../protocol/process-messages';
import { useProcessStore } from '../state/processStore';

const RECONNECT_MS = 2000;

export function useProcessSocket(enabled: boolean) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(false);
  const [state, setState] = useState<ConnectionState>('connecting');

  enabledRef.current = enabled;

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabledRef.current) return;
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes`);
    socketRef.current = ws;

    ws.onopen = () => {
      setState('connected');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ProcessServerMessage;
        if (message.type === 'snapshot') {
          useProcessStore.getState().setSnapshot(message);
        } else if (message.type === 'kill_result') {
          useProcessStore.getState().setMessage(message);
        } else if (message.type === 'error') {
          useProcessStore.getState().setMessage(message);
        }
      } catch {
        useProcessStore.getState().setMessage({ type: 'error', message: 'Invalid process viewer response' });
      }
    };

    ws.onclose = () => {
      if (socketRef.current === ws) socketRef.current = null;
      if (!mountedRef.current || !enabledRef.current) return;
      setState('reconnecting');
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_MS);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) {
      setState('connecting');
      connect();
    } else {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    }

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, enabled]);

  const sendKill = useCallback((pid: number) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      useProcessStore.getState().setMessage({ type: 'error', message: 'Process viewer is not connected' });
      return;
    }
    ws.send(JSON.stringify({ type: 'kill', pid }));
  }, []);

  return { sendKill, state };
}
