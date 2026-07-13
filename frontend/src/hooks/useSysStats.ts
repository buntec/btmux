import { useEffect, useRef, useState } from 'react';

export interface SysStats {
  cpu: number[];
  mem_used: number;
  mem_total: number;
  net_rx: number;
  net_tx: number;
}

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sysstat`;
const RECONNECT_MS = 2000;

export function useSysStats(): SysStats | null {
  const [stats, setStats] = useState<SysStats | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      if (!mountedRef.current) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          setStats(JSON.parse(e.data) as SysStats);
        } catch {}
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        timerRef.current = setTimeout(connect, RECONNECT_MS);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return stats;
}
