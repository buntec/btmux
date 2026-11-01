export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  extension: string | null;
  is_ignored: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  mime_type: string;
  encoding: string;
  size: number;
  truncated: boolean;
}

export interface FileMetadata {
  path: string;
  size: number;
  modified: string | null;
  created: string | null;
  is_dir: boolean;
  is_symlink: boolean;
  permissions: string;
}

export interface TreeNode {
  name: string;
  is_dir: boolean;
  children: TreeNode[] | null;
  truncated: boolean;
}

export interface FileSearchResult {
  path: string;
  indices: number[];
}

export interface SearchResult {
  path: string;
  line: number | null;
  text: string | null;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'typechange';

export interface StatusEntry {
  path: string;
  status: FileStatus;
  old_path: string | null;
  additions: number;
  deletions: number;
}

export interface LineStats {
  additions: number;
  deletions: number;
}

export interface GitHead {
  branch: string | null;
  commit_sha: string;
  commit_message: string;
  ahead: number;
  behind: number;
}

export interface GitStatusResult {
  head: GitHead;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  untracked_stats: Record<string, LineStats>;
  is_repo: boolean;
  is_repo_root: boolean;
  /** Absolute worktree root; status paths are relative to it. */
  workdir: string | null;
}

export type GitLogRefKind = 'branch' | 'remote' | 'tag';

export interface GitLogRef {
  name: string;
  kind: GitLogRefKind;
}

export interface GitLogCommit {
  id: string;
  short_id: string;
  parents: string[];
  summary: string;
  author: string;
  timestamp: number;
  refs: GitLogRef[];
  is_head: boolean;
}

export interface GitLogResult {
  commits: GitLogCommit[];
  truncated: boolean;
}

export interface GitCommitDiffResult {
  commit_id: string;
  files: FileDiff[];
}

export interface DiffLine {
  origin: string;
  content: string;
}

export interface DiffHunk {
  header: string;
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  hunks: DiffHunk[];
  is_binary: boolean;
}

export interface ClientFileMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ServerFileMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

let _id = 0;
export function nextId(): string {
  return String(++_id);
}

export interface GitBranchInfo {
  name: string;
  is_head: boolean;
  upstream: string | null;
  upstream_gone: boolean;
  ahead: number;
  behind: number;
  commit: string;
  subject: string;
}

export interface GitStashInfo {
  index: number;
  message: string;
}

export interface GitWorktreeInfo {
  /** The root, spelled as `PaneGit.worktree_root`. */
  path: string;
  /** Null when HEAD is detached. */
  branch: string | null;
  head: string;
  subject: string;
  main: boolean;
  bare: boolean;
  /** Contains the browsed directory. */
  current: boolean;
  /** The lock reason, possibly empty. */
  locked: string | null;
  prunable: boolean;
}

export interface GitRefsResult {
  branch: string | null;
  upstream: string | null;
  local_branches: GitBranchInfo[];
  remote_branches: GitBranchInfo[];
  remotes: string[];
  stashes: GitStashInfo[];
  worktrees: GitWorktreeInfo[];
}

export type GitOp =
  | { kind: 'checkout'; target: string }
  | { kind: 'create_branch'; name: string; checkout: boolean }
  | { kind: 'rename_branch'; from: string; to: string }
  | { kind: 'delete_branch'; name: string; force?: boolean }
  | { kind: 'fetch'; remote?: string; all?: boolean; prune?: boolean; tags?: boolean }
  | { kind: 'pull'; remote?: string; branch?: string; rebase?: boolean; ff_only?: boolean }
  | {
      kind: 'push';
      remote?: string;
      refspec?: string;
      set_upstream?: boolean;
      force_with_lease?: boolean;
      no_verify?: boolean;
      dry_run?: boolean;
      tags?: boolean;
    }
  | { kind: 'stash_push'; message?: string; staged?: boolean; include_untracked?: boolean; all?: boolean }
  | { kind: 'stash_apply'; index: number; pop: boolean }
  | { kind: 'stash_drop'; index: number }
  | { kind: 'stage_all' }
  | { kind: 'unstage_all' };

/** `git_worktree` operations (`worktree::Op`). */
export type WorktreeOp =
  | { kind: 'add'; branch: string; visit?: boolean }
  | { kind: 'open'; path: string }
  | { kind: 'remove'; path: string; force?: boolean }
  | { kind: 'lock'; path: string }
  | { kind: 'unlock'; path: string }
  | { kind: 'prune' };
