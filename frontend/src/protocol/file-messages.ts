export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  extension: string | null;
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
}

export interface GitHead {
  branch: string | null;
  commit_sha: string;
  commit_message: string;
}

export interface GitStatusResult {
  head: GitHead;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  is_repo: boolean;
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
