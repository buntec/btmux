import { useEffect, useMemo, useState } from 'react';
import type { GitStatusResult } from '../protocol/file-messages';
import { gitCounts, sameGitCounts, type GitCounts } from '../lib/gitStatus';
import { ScanPool } from '../lib/scanPool';
import { useFileSocket } from './useFileSocket';

const POLL_MS = 5000;
/** Concurrent scans, as the file tree limits them. */
const MAX_SCANS = 8;

/**
 * The status of each worktree root, rescanned while `enabled`. The last result
 * stays while hidden, so reopening shows it until the rescan. Scans outlive the
 * effect: the backend finishes them anyway, so reopening joins them.
 */
export function useWorktreeStatuses(roots: string[], enabled: boolean): ReadonlyMap<string, GitCounts> {
  const { send } = useFileSocket();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitCounts>>(new Map());
  const key = roots.join('\0');

  const pool = useMemo(
    () =>
      new ScanPool(async (root) => {
        const response = await send('git_status', { root });
        const status = response.payload as unknown as GitStatusResult;
        const counts = status.is_repo ? gitCounts(status) : null;
        setStatuses((previous) => {
          const before = previous.get(root);
          if (counts ? before && sameGitCounts(before, counts) : !before) return previous;
          const next = new Map(previous);
          if (counts) next.set(root, counts);
          else next.delete(root);
          return next;
        });
      }, MAX_SCANS),
    [send],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
      await pool.run(roots, () => cancelled);
      if (!cancelled) timer = setTimeout(scan, POLL_MS);
    };
    void scan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, enabled, pool]);

  return statuses;
}
