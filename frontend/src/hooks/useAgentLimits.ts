import { useEffect, useState } from 'react';
import type { AgentLimits } from '../generated/protocol';

const POLL_MS = 60_000;

/** Polls while mounted and the tab is visible; each read makes the server run the agent CLIs. */
export function useAgentLimits(): AgentLimits[] {
  const [limits, setLimits] = useState<AgentLimits[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      fetch('/api/agent-limits', { signal: controller.signal, cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<AgentLimits[]>;
        })
        .then(setLimits)
        // Keeps what it has; the server already keeps limits through failed reads.
        .catch(() => {});
    };
    const schedule = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.hidden) return;
      read();
      timer = setInterval(read, POLL_MS);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, []);
  return limits;
}
