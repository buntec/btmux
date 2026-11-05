import { useEffect, useState } from 'react';
import type { AgentLimits } from '../generated/protocol';

const POLL_MS = 60_000;

// Survives the Usage tab unmounting, so reopening it shows limits at once.
let lastRead: AgentLimits[] | null = null;

/**
 * Polls while mounted and the tab is visible; each read makes the server run the agent CLIs.
 * Null until the first read settles.
 */
export function useAgentLimits(): AgentLimits[] | null {
  const [limits, setLimits] = useState(lastRead);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      fetch('/api/agent-limits', { signal: controller.signal, cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<AgentLimits[]>;
        })
        .then((reply) => {
          lastRead = reply;
          setLimits(reply);
        })
        // Keeps what it has; the server already keeps limits through failed reads.
        .catch(() => {
          if (!controller.signal.aborted) setLimits((current) => current ?? []);
        });
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
