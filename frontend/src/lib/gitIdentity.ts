import type { PaneGit } from '../state/types';

type GitPane = { git: PaneGit | null };
type GitWindow = { panes: GitPane[]; active_pane: number };

// Windows and sessions have no git identity of their own: it's derived from
// their panes' (`PaneSnapshot.git`), ignoring panes outside a repo.

/**
 * Token colors for repos, distinct in base16 schemes (teal and purple aren't);
 * blue marks the active window and attached session.
 */
const REPO_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'pink'] as const;
export type RepoColor = (typeof REPO_COLORS)[number];

/**
 * A color per repo, shared by all its worktrees: its hashed color, or the next
 * one free, so repos differ while there are enough colors.
 */
export function repoColors(repoIds: Iterable<string>): Map<string, RepoColor> {
  const colors = new Map<string, RepoColor>();
  const used = new Set<number>();
  for (const id of [...new Set(repoIds)].sort()) {
    let slot = hash(id) % REPO_COLORS.length;
    if (used.size < REPO_COLORS.length) while (used.has(slot)) slot = (slot + 1) % REPO_COLORS.length;
    used.add(slot);
    colors.set(id, REPO_COLORS[slot]);
  }
  return colors;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const char of s) h = Math.imul(h ^ char.codePointAt(0)!, 16777619) >>> 0;
  return h;
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
