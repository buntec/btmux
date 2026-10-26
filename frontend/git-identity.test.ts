// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import {
  gitMatches,
  labeledSessionRepos,
  repoColor,
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
  // The repo it is named after is not labeled.
  expect(labeledSessionRepos(sess)).toEqual([]);
  expect(labeledSessionRepos({ ...sess, name: 'work' })).toEqual([main]);
  expect(labeledSessionRepos({ ...sess, windows: [...sess.windows, win([other])] })).toEqual([other]);
});

test('worktrees share their repo color', () => {
  expect(repoColor(feat.repo_id)).toBe(repoColor(main.repo_id));
  expect(repoColor(main.repo_id)).not.toBe('blue');
});

test('labels and filter matches', () => {
  expect(worktreeLabel(feat)).toBe('feat');
  expect(worktreeLabel({ ...feat, branch: null })).toBe('proj-feat');
  expect(gitMatches(feat, 'fea')).toBe(true);
  expect(gitMatches(feat, 'proj-f')).toBe(true);
  expect(gitMatches(main, 'feat')).toBe(false);
});
