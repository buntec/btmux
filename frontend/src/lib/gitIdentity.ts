import type { PaneGit } from '../state/types';

type GitPane = { git: PaneGit | null };
type GitWindow = { panes: GitPane[]; active_pane: number };

// Windows and sessions have no git identity of their own: it's derived from
// their panes' (`PaneSnapshot.git`), ignoring panes outside a repo.

/** Token colors for repos; blue marks the active window and attached session. */
const REPO_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'purple', 'pink'] as const;
export type RepoColor = (typeof REPO_COLORS)[number];

/** A stable color per repo, shared by all its worktrees. */
export function repoColor(repoId: string): RepoColor {
  let hash = 2166136261;
  for (const char of repoId) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  return REPO_COLORS[hash % REPO_COLORS.length];
}

/** The distinct worktrees of a window's panes, the active pane's first. */
export function windowWorktrees(win: GitWindow): PaneGit[] {
  const active = win.panes[win.active_pane];
  const panes = active ? [active, ...win.panes.filter((p) => p !== active)] : win.panes;
  return distinct(panes, (git) => `${git.repo_id}\0${git.worktree_root}`);
}

/** The distinct repos of a session's panes, in window order. */
export function sessionRepos(sess: { windows: GitWindow[] }): PaneGit[] {
  return distinct(
    sess.windows.flatMap((win) => win.panes),
    (git) => git.repo_id,
  );
}

/** Repos worth naming on a session row: those it isn't named after. */
export function labeledSessionRepos(sess: { name: string; windows: GitWindow[] }): PaneGit[] {
  return sessionRepos(sess).filter((git) => git.repo_name.toLowerCase() !== sess.name.toLowerCase());
}

/** The worktree's branch, or its folder when HEAD is detached. */
export function worktreeLabel(git: PaneGit): string {
  return git.branch ?? basename(git.worktree_root);
}

/** Whether a lowercase filter query matches a repo, branch, or worktree folder. */
export function gitMatches(git: PaneGit, query: string): boolean {
  return [git.repo_name, git.branch ?? '', basename(git.worktree_root)].some((s) => s.toLowerCase().includes(query));
}

function distinct(panes: GitPane[], key: (git: PaneGit) => string): PaneGit[] {
  const seen = new Map<string, PaneGit>();
  for (const { git } of panes) {
    if (git && !seen.has(key(git))) seen.set(key(git), git);
  }
  return [...seen.values()];
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
