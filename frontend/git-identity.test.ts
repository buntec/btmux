// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import {
  gitMatches,
  repoColors,
  sessionRepos,
  windowWorktrees,
  worktreeLabel,
} from './src/lib/gitIdentity';
import type { PaneGit } from './src/state/types';

const main: PaneGit = {
  repo_id: '/src/proj/.git',
  repo_name: 'proj',
  worktree_root: '/src/proj',
  branch: 'main',
  main_worktree: true,
};
const feat: PaneGit = { ...main, worktree_root: '/src/proj-feat', branch: 'feat', main_worktree: false };
const other: PaneGit = { ...main, repo_id: '/src/other/.git', repo_name: 'other', worktree_root: '/src/other' };

const pane = (git: PaneGit | null) => ({ git });
const win = (gits: (PaneGit | null)[], active_pane = 0) => ({ panes: gits.map(pane), active_pane });

test('window worktrees are distinct, active pane first, ignoring panes outside repos', () => {
  expect(windowWorktrees(win([main, null, main]))).toEqual([main]);
  expect(windowWorktrees(win([main, feat], 1))).toEqual([feat, main]);
  expect(windowWorktrees(win([null]))).toEqual([]);
});

test('session repos group worktrees of one repo', () => {
  const sess = { name: 'proj', windows: [win([main]), win([feat, null]), win([null])] };
  expect(sessionRepos(sess)).toEqual([main]);
  expect(sessionRepos({ ...sess, windows: [...sess.windows, win([other])] })).toEqual([main, other]);
});

test('repos get distinct colors while there are enough', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `/src/repo${i}/.git`);
  const colors = repoColors([...ids, feat.repo_id, main.repo_id]);
  expect(colors.size).toBe(7);
  expect(new Set([...colors.values()].slice(0, 6)).size).toBe(6);
  expect([...colors.values()]).not.toContain('blue');
  // Independent of input order.
  expect(repoColors([...ids].reverse())).toEqual(repoColors(ids));
});

test('labels and filter matches', () => {
  expect(worktreeLabel(feat)).toBe('feat');
  expect(worktreeLabel({ ...feat, branch: null })).toBe('proj-feat');
  expect(gitMatches(feat, 'fea')).toBe(true);
  expect(gitMatches(feat, 'proj-f')).toBe(true);
  expect(gitMatches(main, 'feat')).toBe(false);
});
