import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '../lib/connectionState';
import type {
  ProcessKillRequest,
  ProcessPortsRequest,
  ProcessServerMessage,
  ProcessSignal,
} from '../protocol/process-messages';
import { useStore } from '../state/store';
import { useProcessStore } from '../state/processStore';

const RECONNECT_MS = 2000;

export function useProcessSocket(enabled: boolean) {
  const viewMode = useProcessStore((s) => s.viewMode);
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
      if (useProcessStore.getState().viewMode === 'ports') {
        const request: ProcessPortsRequest = { type: 'set_ports', enabled: true };
        ws.send(JSON.stringify(request));
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ProcessServerMessage;
        if (message.type === 'snapshot') {
          useProcessStore.getState().setSnapshot(message);
        } else if (message.type === 'kill_result') {
          useStore.getState().showToast(message.message, message.success ? 'success' : 'error');
        } else if (message.type === 'error') {
          useStore.getState().showToast(message.message, 'error');
        }
      } catch {
        useStore.getState().showToast('Invalid process viewer response', 'error');
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

  useEffect(() => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const request: ProcessPortsRequest = { type: 'set_ports', enabled: viewMode === 'ports' };
      ws.send(JSON.stringify(request));
    }
  }, [viewMode]);

  const sendKill = useCallback((pid: number, startTime: number, signal: ProcessSignal) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      useStore.getState().showToast('Process viewer is not connected', 'error');
      return;
    }
    const request: ProcessKillRequest = { type: 'kill', pid, start_time: startTime, signal };
    ws.send(JSON.stringify(request));
  }, []);

  return { sendKill, state };
}
