import { useRef, useCallback } from 'react';
import type { ServerFileMessage } from '../protocol/file-messages';
import { nextId } from '../protocol/file-messages';

type PendingRequest = {
  resolve: (msg: ServerFileMessage) => void;
  reject: (err: Error) => void;
};

export function useFileSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const queueRef = useRef<string[]>([]);

  const connect = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/files`);
    socketRef.current = ws;

    ws.onopen = () => {
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

  return { send };
}
