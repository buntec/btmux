import { useEffect, useRef, useCallback, useState } from 'react';
import type { ServerFileMessage } from '../protocol/file-messages';
import { nextId } from '../protocol/file-messages';
import type { ConnectionState } from '../lib/connectionState';

type PendingRequest = {
  resolve: (msg: ServerFileMessage) => void;
  reject: (err: Error) => void;
};

const RECONNECT_MS = 2000;

export function useFileSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const queueRef = useRef<string[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<ConnectionState>('connecting');

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/files`);
    socketRef.current = ws;

    ws.onopen = () => {
      setState('connected');
      for (const msg of queueRef.current) {
        ws.send(msg);
      }
      queueRef.current = [];
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerFileMessage = JSON.parse(event.data);
        if (msg.id) {
          const pending = pendingRef.current.get(msg.id);
          if (pending) {
            pendingRef.current.delete(msg.id);
            if (msg.type === 'error') {
              pending.reject(new Error((msg.payload as { message?: string }).message ?? 'Unknown error'));
            } else {
              pending.resolve(msg);
            }
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      socketRef.current = null;
      for (const [, pending] of pendingRef.current) {
        pending.reject(new Error('WebSocket closed'));
      }
      pendingRef.current.clear();
      if (!mountedRef.current) return;
      setState('reconnecting');
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_MS);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback(
    (type: string, payload: Record<string, unknown>): Promise<ServerFileMessage> => {
      connect();
      const id = nextId();
      const msg = JSON.stringify({ id, type, payload });

      return new Promise((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        } else {
          queueRef.current.push(msg);
        }
      });
    },
    [connect],
  );

  return { send, state };
}
