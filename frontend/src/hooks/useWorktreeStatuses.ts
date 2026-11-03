import { useEffect, useState } from 'react';
import type { GitStatusResult } from '../protocol/file-messages';
import { gitCounts, sameGitCounts, type GitCounts } from '../lib/gitStatus';
import { useFileSocket } from './useFileSocket';

const POLL_MS = 5000;
/** Concurrent scans, as the file tree limits them. */
const BATCH = 8;

/**
 * The status of each worktree root, rescanned while `enabled`. The last result
 * stays while hidden, so reopening shows it until the rescan.
 */
export function useWorktreeStatuses(roots: string[], enabled: boolean): ReadonlyMap<string, GitCounts> {
  const { send } = useFileSocket();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitCounts>>(new Map());
  const key = roots.join('\0');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scanOne = async (root: string) => {
      let counts: GitCounts | null;
      try {
        const response = await send('git_status', { root });
        const status = response.payload as unknown as GitStatusResult;
        counts = status.is_repo ? gitCounts(status) : null;
      } catch {
        return;
      }
      if (cancelled) return;
      setStatuses((previous) => {
        const before = previous.get(root);
        if (counts ? before && sameGitCounts(before, counts) : !before) return previous;
        const next = new Map(previous);
        if (counts) next.set(root, counts);
        else next.delete(root);
        return next;
      });
    };
    const scan = async () => {
      for (let i = 0; i < roots.length && !cancelled; i += BATCH) {
        await Promise.all(roots.slice(i, i + BATCH).map(scanOne));
      }
      if (!cancelled) timer = setTimeout(scan, POLL_MS);
    };
    void scan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, enabled, send]);

  return statuses;
}
