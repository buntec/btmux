use git2::{
    BranchType, DiffDelta, DiffFindOptions, DiffHunk as GitDiffHunk, DiffLine as GitDiffLine,
    DiffOptions, ErrorCode, Oid, Repository, Sort, Status, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Typechange,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatusEntry {
    pub path: String,
    pub status: FileStatus,
    pub old_path: Option<String>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default)]
pub struct LineStats {
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitHead {
    pub branch: Option<String>,
    pub commit_sha: String,
    pub commit_message: String,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub head: GitHead,
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub untracked: Vec<String>,
    pub untracked_stats: HashMap<String, LineStats>,
    pub is_repo: bool,
    pub is_repo_root: bool,
    /// Absolute worktree root; status paths are relative to it.
    pub workdir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitLogRef {
    pub name: String,
    pub kind: String,
}

const MAX_COMMIT_DIFF_FILES: usize = 1000;
const MAX_COMMIT_DIFF_LINES: usize = 50_000;
const MAX_DIFF_FILE_LINES: usize = 20_000;
const MAX_DIFF_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIFF_LINE_BYTES: usize = 4096;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitLogCommit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author: String,
    pub timestamp: i64,
    pub refs: Vec<GitLogRef>,
    pub is_head: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogResult {
    pub commits: Vec<GitLogCommit>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCommitDiff {
    pub commit_id: String,
    pub total_files: usize,
    pub additions: usize,
    pub deletions: usize,
    pub files: Vec<CommitFileDiff>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitFileDiff {
    #[serde(flatten)]
    pub diff: FileDiff,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffLine {
    pub origin: char,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub truncated: bool,
}

pub async fn git_status(root: &Path, include_diff_stats: bool) -> Result<GitStatusResult, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || git_status_sync(&root, include_diff_stats))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_log(root: &Path, max_count: usize) -> Result<GitLogResult, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || git_log_sync(&root, max_count))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_commit_diff(
    root: &Path,
    commit_id: &str,
    context_lines: u32,
) -> Result<GitCommitDiff, String> {
    let root = root.to_path_buf();
    let commit_id = commit_id.to_string();
    tokio::task::spawn_blocking(move || git_commit_diff_sync(&root, &commit_id, context_lines))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_diff_file(
    root: &Path,
    path: &str,
    staged: bool,
    ignore_all_space: bool,
    context_lines: u32,
) -> Result<FileDiff, String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || {
        git_diff_file_sync(&root, &path, staged, ignore_all_space, context_lines)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn git_stage_file(root: &Path, path: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || git_stage_file_sync(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_unstage_file(root: &Path, path: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || git_unstage_file_sync(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_discard_file(root: &Path, path: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || git_discard_file_sync(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_delete_untracked_file(root: &Path, path: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || git_delete_untracked_file_sync(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_commit(root: &Path, subject: &str, body: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let subject = subject.to_string();
    let body = body.to_string();
    tokio::task::spawn_blocking(move || git_commit_sync(&root, &subject, &body))
        .await
        .map_err(|e| e.to_string())?
}

fn open_repo(root: &Path) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("Not a git repository: {}", e))
}

/// Returns the subset of `names` (entries of `dir`) that are gitignored.
/// Empty if `dir` isn't inside a git repository.
pub fn ignored_names(dir: &Path, names: &[String]) -> HashSet<String> {
    let mut result = HashSet::new();
    let Ok(repo) = Repository::discover(dir) else {
        return result;
    };
    let Some(workdir) = repo.workdir() else {
        return result;
    };
    let Ok(rel_dir) = dir.strip_prefix(workdir) else {
        return result;
    };
    for name in names {
        if repo
            .status_should_ignore(&rel_dir.join(name))
            .unwrap_or(false)
        {
            result.insert(name.clone());
        }
    }
    result
}

fn git_status_sync(root: &Path, include_diff_stats: bool) -> Result<GitStatusResult, String> {
    let repo = match Repository::discover(root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitStatusResult {
                head: GitHead {
                    branch: None,
                    commit_sha: String::new(),
                    commit_message: String::new(),
                    ahead: 0,
                    behind: 0,
                },
                staged: vec![],
                unstaged: vec![],
                untracked: vec![],
                untracked_stats: HashMap::new(),
                is_repo: false,
                is_repo_root: false,
                workdir: None,
            });
        }
    };

    let prefix = repo
        .workdir()
        .and_then(|wd| root.strip_prefix(wd).ok())
        .map(|p| {
            // Git paths are `/`-separated on Windows too.
            let s = crate::fs_ops::client_path(p);
            if s.is_empty() || s.ends_with('/') {
                s
            } else {
                format!("{}/", s)
            }
        })
        .unwrap_or_default();

    let head = get_head_info(&repo);
    let is_repo_root = repo.workdir().is_some_and(|workdir| workdir == root);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    if !prefix.is_empty() {
        opts.pathspec(&prefix);
    }

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let (staged_stats, unstaged_stats) = if include_diff_stats {
        (
            diff_line_stats(&repo, &prefix, true)?,
            diff_line_stats(&repo, &prefix, false)?,
        )
    } else {
        (HashMap::new(), HashMap::new())
    };

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        if !prefix.is_empty() && !path.starts_with(&prefix) {
            continue;
        }
        let st = entry.status();

        if st.contains(Status::WT_NEW) {
            untracked.push(path.clone());
        }

        if st.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            let path = delta_new_path(entry.head_to_index()).unwrap_or_else(|| path.clone());
            staged.push(StatusEntry {
                path: path.clone(),
                status: index_status_to_enum(st),
                old_path: rename_old_path(entry.head_to_index(), &path),
                additions: staged_stats.get(&path).map_or(0, |stats| stats.additions),
                deletions: staged_stats.get(&path).map_or(0, |stats| stats.deletions),
            });
        }

        if st.intersects(
            Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE | Status::WT_RENAMED,
        ) {
            let path = delta_new_path(entry.index_to_workdir()).unwrap_or_else(|| path.clone());
            unstaged.push(StatusEntry {
                path: path.clone(),
                status: wt_status_to_enum(st),
                old_path: rename_old_path(entry.index_to_workdir(), &path),
                additions: unstaged_stats.get(&path).map_or(0, |stats| stats.additions),
                deletions: unstaged_stats.get(&path).map_or(0, |stats| stats.deletions),
            });
        }
    }

    let untracked_stats = if include_diff_stats {
        untracked
            .iter()
            .map(|path| {
                let stats = repo
                    .workdir()
                    .map(|workdir| count_untracked_lines(&workdir.join(path)))
                    .unwrap_or_default();
                (path.clone(), stats)
            })
            .collect()
    } else {
        HashMap::new()
    };

    Ok(GitStatusResult {
        head,
        staged,
        unstaged,
        untracked,
        untracked_stats,
        is_repo: true,
        is_repo_root,
        workdir: repo
            .workdir()
            .map(|wd| wd.to_string_lossy().trim_end_matches('/').to_string()),
    })
}

fn git_log_sync(root: &Path, max_count: usize) -> Result<GitLogResult, String> {
    let repo = open_repo(root)?;
    let max_count = max_count.max(1);

    let mut refs_by_commit: HashMap<git2::Oid, Vec<GitLogRef>> = HashMap::new();
    let references = repo
        .references()
        .map_err(|e| format!("Failed to read references: {}", e))?;
    for reference in references {
        let reference = reference.map_err(|e| format!("Failed to read reference: {}", e))?;
        let Ok(name) = reference.name() else {
            continue;
        };
        let Some((kind, display_name)) = display_ref_name(name) else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        refs_by_commit
            .entry(commit.id())
            .or_default()
            .push(GitLogRef {
                name: display_name,
                kind: kind.to_string(),
            });
    }
    for refs in refs_by_commit.values_mut() {
        refs.sort_by(|a, b| a.name.cmp(&b.name));
    }

    let head_oid = repo.head().ok().and_then(|head| head.target());
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to walk history: {}", e))?;
    revwalk
        .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|e| format!("Failed to sort history: {}", e))?;

    let has_refs = revwalk.push_glob("refs/*").is_ok();
    let has_head = if head_oid.is_some() {
        revwalk
            .push_head()
            .map_err(|e| format!("Failed to start history walk: {}", e))?;
        true
    } else {
        false
    };

    if !has_refs && !has_head {
        return Ok(GitLogResult {
            commits: Vec::new(),
            truncated: false,
        });
    }

    let mut commits = Vec::new();
    let mut truncated = false;
    for (index, oid) in revwalk.enumerate() {
        if index >= max_count {
            truncated = true;
            break;
        }
        let oid = oid.map_err(|e| format!("Failed to read history commit: {}", e))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to read history commit: {}", e))?;
        let id = oid.to_string();
        let short_id = id.chars().take(7).collect();
        let author = commit
            .author()
            .name()
            .unwrap_or("Unknown author")
            .to_string();
        let parents = commit
            .parent_ids()
            .map(|parent| parent.to_string())
            .collect();

        commits.push(GitLogCommit {
            id: id.clone(),
            short_id,
            parents,
            summary: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or("(no subject)")
                .to_string(),
            author,
            timestamp: commit.time().seconds(),
            refs: refs_by_commit.remove(&oid).unwrap_or_default(),
            is_head: head_oid == Some(oid),
        });
    }

    Ok(GitLogResult { commits, truncated })
}

fn display_ref_name(name: &str) -> Option<(&'static str, String)> {
    if let Some(name) = name.strip_prefix("refs/heads/") {
        return Some(("branch", name.to_string()));
    }
    if let Some(name) = name.strip_prefix("refs/remotes/") {
        return Some(("remote", name.to_string()));
    }
    if let Some(name) = name.strip_prefix("refs/tags/") {
        return Some(("tag", name.to_string()));
    }
    None
}

fn git_commit_diff_sync(
    root: &Path,
    commit_id: &str,
    context_lines: u32,
) -> Result<GitCommitDiff, String> {
    let repo = open_repo(root)?;
    let oid = Oid::from_str(commit_id).map_err(|e| format!("Invalid commit id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Failed to find commit: {}", e))?;
    let commit_tree = commit
        .tree()
        .map_err(|e| format!("Failed to read commit tree: {}", e))?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(context_lines);
    let diff = repo
        .diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&commit_tree),
            Some(&mut diff_opts),
        )
        .map_err(|e| format!("Failed to get commit diff: {}", e))?;

    commit_diff_from(oid.to_string(), &diff)
}

/// Counts every file, but sends only what a browser can parse and show.
fn commit_diff_from(commit_id: String, diff: &git2::Diff<'_>) -> Result<GitCommitDiff, String> {
    let mut result = GitCommitDiff {
        commit_id,
        total_files: diff.deltas().len(),
        additions: 0,
        deletions: 0,
        files: Vec::new(),
    };
    let mut budget = DiffBudget::new(MAX_COMMIT_DIFF_LINES);

    for delta_idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(delta_idx).unwrap();
        let patch = git2::Patch::from_diff(diff, delta_idx).ok().flatten();
        let (_, additions, deletions) = patch
            .as_ref()
            .and_then(|patch| patch.line_stats().ok())
            .unwrap_or_default();
        result.additions += additions;
        result.deletions += deletions;
        if result.files.len() == MAX_COMMIT_DIFF_FILES {
            continue;
        }

        let diff_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let old_path = delta.old_file().path().and_then(|path| {
            let path = path.to_string_lossy().into_owned();
            (path != diff_path).then_some(path)
        });

        budget.next_file();
        let (hunks, truncated) = match patch {
            Some(patch) => patch_hunks(&patch, &mut budget)?,
            None => (Vec::new(), false),
        };

        result.files.push(CommitFileDiff {
            diff: FileDiff {
                path: diff_path,
                old_path,
                hunks,
                is_binary: delta.flags().is_binary(),
                truncated,
            },
            additions,
            deletions,
        });
    }

    Ok(result)
}

/// What a diff may still send, since a browser must parse and show it.
struct DiffBudget {
    lines: usize,
    file_lines: usize,
    bytes: usize,
}

impl DiffBudget {
    fn new(lines: usize) -> Self {
        Self {
            lines,
            file_lines: MAX_DIFF_FILE_LINES,
            bytes: MAX_DIFF_BYTES,
        }
    }

    fn next_file(&mut self) {
        self.file_lines = MAX_DIFF_FILE_LINES;
    }

    /// The line's capped text, or `None` once the budget is spent.
    fn take_line(&mut self, content: &[u8]) -> Option<String> {
        if self.lines == 0 || self.file_lines == 0 {
            return None;
        }
        // Charged as sent: invalid bytes grow to U+FFFD.
        let text = capped_line_content(content);
        if self.bytes < text.len() {
            return None;
        }
        self.lines -= 1;
        self.file_lines -= 1;
        self.bytes -= text.len();
        Some(text)
    }
}

fn capped_line_content(content: &[u8]) -> String {
    if content.len() <= MAX_DIFF_LINE_BYTES {
        return String::from_utf8_lossy(content).into_owned();
    }
    let cut = &content[..MAX_DIFF_LINE_BYTES];
    // Don't cut a character in half.
    let end = match std::str::from_utf8(cut) {
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        _ => cut.len(),
    };
    let mut text = String::from_utf8_lossy(&cut[..end]).into_owned();
    text.push('…');
    text
}

/// The patch's hunks within the budget, and whether any line was cut or didn't fit.
fn patch_hunks(
    patch: &git2::Patch<'_>,
    budget: &mut DiffBudget,
) -> Result<(Vec<DiffHunk>, bool), String> {
    let mut hunks = Vec::new();
    let mut shortened = false;
    for hunk_idx in 0..patch.num_hunks() {
        let (hunk, _num_lines) = patch
            .hunk(hunk_idx)
            .map_err(|e| format!("Failed to get diff hunk: {}", e))?;
        let num_lines = patch
            .num_lines_in_hunk(hunk_idx)
            .map_err(|e| format!("Failed to get diff line count: {}", e))?;
        let mut lines = Vec::with_capacity(num_lines.min(budget.file_lines));
        let mut spent = false;

        for line_idx in 0..num_lines {
            let line = patch
                .line_in_hunk(hunk_idx, line_idx)
                .map_err(|e| format!("Failed to get diff line: {}", e))?;
            let Some(content) = budget.take_line(line.content()) else {
                spent = true;
                break;
            };
            shortened |= line.content().len() > MAX_DIFF_LINE_BYTES;
            lines.push(DiffLine {
                origin: line.origin(),
                content,
            });
        }

        if !lines.is_empty() {
            hunks.push(DiffHunk {
                header: String::from_utf8_lossy(hunk.header()).trim().to_string(),
                old_start: hunk.old_start(),
                new_start: hunk.new_start(),
                lines,
            });
        }
        if spent {
            return Ok((hunks, true));
        }
    }
    Ok((hunks, shortened))
}

fn diff_line_stats(
    repo: &Repository,
    prefix: &str,
    staged: bool,
) -> Result<HashMap<String, LineStats>, String> {
    let mut diff_opts = DiffOptions::new();
    if !prefix.is_empty() {
        diff_opts.pathspec(prefix);
    }

    let diff = if staged {
        staged_diff(repo, &mut diff_opts)?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("Failed to get diff stats: {}", e))?
    };

    let mut stats = HashMap::new();
    let mut file_cb = |_delta: DiffDelta<'_>, _progress: f32| true;
    let mut line_cb =
        |delta: DiffDelta<'_>, _hunk: Option<GitDiffHunk<'_>>, line: GitDiffLine<'_>| {
            let Some(path) = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|path| path.to_string_lossy().into_owned())
            else {
                return true;
            };

            let entry = stats.entry(path).or_insert_with(LineStats::default);
            match line.origin() {
                '+' => entry.additions += line.num_lines().max(1) as usize,
                '-' => entry.deletions += line.num_lines().max(1) as usize,
                _ => {}
            }
            true
        };

    diff.foreach(&mut file_cb, None, None, Some(&mut line_cb))
        .map_err(|e| format!("Failed to count diff stats: {}", e))?;
    Ok(stats)
}

fn count_untracked_lines(path: &Path) -> LineStats {
    let Ok(content) = std::fs::read(path) else {
        return LineStats::default();
    };

    // Git reports binary changes without line additions or deletions.
    if content.contains(&0) {
        return LineStats::default();
    }

    let additions = if content.is_empty() {
        0
    } else {
        content.iter().filter(|byte| **byte == b'\n').count()
            + usize::from(!content.ends_with(b"\n"))
    };
    LineStats {
        additions,
        deletions: 0,
    }
}

fn get_head_info(repo: &Repository) -> GitHead {
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .and_then(|r| r.shorthand().ok().map(|s| s.to_string()));

    let local_oid = head.as_ref().and_then(|r| r.target());
    let (ahead, behind) = local_oid
        .zip(
            branch
                .as_deref()
                .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
                .and_then(|branch| branch.upstream().ok())
                .and_then(|upstream| upstream.get().target()),
        )
        .and_then(|(local_oid, upstream_oid)| repo.graph_ahead_behind(local_oid, upstream_oid).ok())
        .unwrap_or((0, 0));

    let (commit_sha, commit_message) = repo
        .head()
        .ok()
        .and_then(|r| r.peel_to_commit().ok())
        .map(|c| {
            (
                c.id().to_string()[..7].to_string(),
                c.summary().ok().flatten().unwrap_or("").to_string(),
            )
        })
        .unwrap_or_default();

    GitHead {
        branch,
        commit_sha,
        commit_message,
        ahead,
        behind,
    }
}

fn delta_new_path(delta: Option<DiffDelta<'_>>) -> Option<String> {
    Some(delta?.new_file().path()?.to_string_lossy().into_owned())
}

fn rename_old_path(delta: Option<DiffDelta<'_>>, path: &str) -> Option<String> {
    let old = delta?.old_file().path()?.to_string_lossy().into_owned();
    (old != path).then_some(old)
}

/// Staged diff (HEAD to index) with rename detection applied.
fn staged_diff<'r>(repo: &'r Repository, opts: &mut DiffOptions) -> Result<git2::Diff<'r>, String> {
    let head_tree = repo.head().ok().and_then(|r| r.peel_to_tree().ok());
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(opts))
        .map_err(|e| format!("Failed to get diff: {}", e))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))
        .map_err(|e| format!("Failed to detect renames: {}", e))?;
    Ok(diff)
}

fn index_status_to_enum(st: Status) -> FileStatus {
    if st.contains(Status::INDEX_NEW) {
        FileStatus::Added
    } else if st.contains(Status::INDEX_DELETED) {
        FileStatus::Deleted
    } else if st.contains(Status::INDEX_RENAMED) {
        FileStatus::Renamed
    } else if st.contains(Status::INDEX_TYPECHANGE) {
        FileStatus::Typechange
    } else {
        FileStatus::Modified
    }
}

fn wt_status_to_enum(st: Status) -> FileStatus {
    if st.contains(Status::WT_DELETED) {
        FileStatus::Deleted
    } else if st.contains(Status::WT_RENAMED) {
        FileStatus::Renamed
    } else if st.contains(Status::WT_TYPECHANGE) {
        FileStatus::Typechange
    } else {
        FileStatus::Modified
    }
}

fn diff_untracked_file(abs_path: &Path, path: &str) -> Result<FileDiff, String> {
    let content =
        std::fs::read_to_string(abs_path).map_err(|e| format!("Cannot read file: {}", e))?;
    let mut budget = DiffBudget::new(MAX_DIFF_FILE_LINES);
    let lines: Vec<DiffLine> = content
        .lines()
        .map_while(|line| {
            let mut content = budget.take_line(line.as_bytes())?;
            content.push('\n');
            Some(DiffLine {
                origin: '+',
                content,
            })
        })
        .collect();
    let num_lines = content.lines().count();
    Ok(FileDiff {
        path: path.to_string(),
        old_path: None,
        truncated: lines.len() < num_lines
            || content.lines().any(|line| line.len() > MAX_DIFF_LINE_BYTES),
        hunks: vec![DiffHunk {
            header: format!("@@ -0,0 +1,{} @@ new file", num_lines),
            old_start: 0,
            new_start: 1,
            lines,
        }],
        is_binary: false,
    })
}

fn git_diff_file_sync(
    root: &Path,
    path: &str,
    staged: bool,
    ignore_all_space: bool,
    context_lines: u32,
) -> Result<FileDiff, String> {
    let repo = open_repo(root)?;

    let mut diff_opts = DiffOptions::new();
    // Staged diffs are filtered after rename detection: a pathspec would hide the rename source.
    if !staged {
        diff_opts.pathspec(path);
    }
    diff_opts.ignore_whitespace(ignore_all_space);
    diff_opts.context_lines(context_lines);

    let workdir = repo.workdir().ok_or("Bare repository")?;
    let abs_path = workdir.join(path);
    if !staged && abs_path.exists() {
        let index = repo
            .index()
            .map_err(|e| format!("Failed to get index: {}", e))?;
        let in_index = index.get_path(std::path::Path::new(path), 0).is_some();
        let in_head = repo
            .head()
            .ok()
            .and_then(|r| r.peel_to_tree().ok())
            .and_then(|t| t.get_path(std::path::Path::new(path)).ok())
            .is_some();
        if !in_index && !in_head {
            return diff_untracked_file(&abs_path, path);
        }
    }

    let diff = if staged {
        staged_diff(&repo, &mut diff_opts)?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("Failed to get diff: {}", e))?
    };

    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut truncated = false;
    let mut budget = DiffBudget::new(MAX_DIFF_FILE_LINES);
    let mut is_binary = false;
    let mut diff_path = path.to_string();
    let mut old_path: Option<String> = None;

    for patch_idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(patch_idx).unwrap();
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let delta_path = new_path.clone().or_else(|| {
            delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned())
        });
        if staged && delta_path.as_deref() != Some(path) {
            continue;
        }
        if let Some(p) = new_path {
            diff_path = p;
        }
        old_path = delta.old_file().path().and_then(|p| {
            let old = p.to_string_lossy().into_owned();
            (old != diff_path).then_some(old)
        });

        let patch = git2::Patch::from_diff(&diff, patch_idx);
        // Loading the patch detects binary content.
        is_binary = delta.flags().is_binary();
        let Ok(Some(patch)) = patch else {
            continue;
        };
        let (patch_hunks, patch_truncated) = patch_hunks(&patch, &mut budget)?;
        hunks.extend(patch_hunks);
        truncated |= patch_truncated;
    }

    Ok(FileDiff {
        path: diff_path,
        old_path,
        hunks,
        is_binary,
        truncated,
    })
}

fn git_stage_file_sync(root: &Path, path: &str) -> Result<(), String> {
    let repo = open_repo(root)?;
    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    let file_path = std::path::Path::new(path);
    let workdir = repo.workdir().ok_or("Bare repository")?;
    let abs_path = workdir.join(file_path);

    if abs_path.exists() {
        index
            .add_path(file_path)
            .map_err(|e| format!("Failed to stage file: {}", e))?;
    } else {
        index
            .remove_path(file_path)
            .map_err(|e| format!("Failed to stage deletion: {}", e))?;
    }

    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;
    Ok(())
}

fn git_unstage_file_sync(root: &Path, path: &str) -> Result<(), String> {
    let repo = open_repo(root)?;

    let head = repo
        .head()
        .and_then(|r| r.peel_to_commit())
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;

    // A staged rename spans two paths; reset both so the pair stays consistent.
    let mut paths = vec![path.to_string()];
    if let Ok(diff) = staged_diff(&repo, &mut DiffOptions::new()) {
        paths.extend(diff.deltas().find_map(|d| {
            let new = d.new_file().path()?.to_string_lossy();
            (d.status() == git2::Delta::Renamed && new == path)
                .then(|| {
                    d.old_file()
                        .path()
                        .map(|p| p.to_string_lossy().into_owned())
                })
                .flatten()
        }));
    }

    repo.reset_default(Some(head.as_object()), paths)
        .map_err(|e| format!("Failed to unstage file: {}", e))?;

    Ok(())
}

fn git_discard_file_sync(root: &Path, path: &str) -> Result<(), String> {
    let repo = open_repo(root)?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.path(path).force();

    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| format!("Failed to discard changes: {}", e))?;

    Ok(())
}

fn git_delete_untracked_file_sync(root: &Path, path: &str) -> Result<(), String> {
    let status = git_status_sync(root, false)?;
    if !status.untracked.iter().any(|untracked| untracked == path) {
        return Err("File is no longer untracked".to_string());
    }

    let repo = open_repo(root)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Repository has no working directory".to_string())?;
    std::fs::remove_file(workdir.join(path))
        .map_err(|e| format!("Failed to delete untracked file: {}", e))
}

fn git_commit_sync(root: &Path, subject: &str, body: &str) -> Result<(), String> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Err("Commit subject cannot be empty".to_string());
    }
    if subject.chars().any(|ch| ch == '\n' || ch == '\r') {
        return Err("Commit subject must be a single line".to_string());
    }

    let repo = open_repo(root)?;
    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("Failed to find tree: {}", e))?;
    let signature = repo
        .signature()
        .map_err(|e| format!("Failed to create commit signature: {}", e))?;
    let parent = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|e| format!("Failed to read HEAD commit: {}", e))?,
        ),
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => return Err(format!("Failed to read HEAD: {}", error)),
    };
    let unchanged = match &parent {
        Some(parent) => parent.tree_id() == tree_id,
        None => index.is_empty(),
    };
    if unchanged {
        return Err("Nothing staged".to_string());
    }
    let parents = parent.iter().collect::<Vec<_>>();
    let message = if body.trim().is_empty() {
        subject.to_string()
    } else {
        format!("{}\n\n{}", subject, body.trim())
    };

    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &message,
        &tree,
        &parents,
    )
    .map_err(|e| format!("Failed to create commit: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        count_untracked_lines, git_commit_diff_sync, git_commit_sync,
        git_delete_untracked_file_sync, git_diff_file_sync, git_log_sync, git_status_sync,
        git_unstage_file_sync, MAX_COMMIT_DIFF_FILES, MAX_COMMIT_DIFF_LINES, MAX_DIFF_BYTES,
        MAX_DIFF_FILE_LINES, MAX_DIFF_LINE_BYTES,
    };
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    #[test]
    fn count_untracked_lines_matches_file_lines() {
        let root = std::env::temp_dir().join(format!("btmux-git-stats-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let path = root.join("file.txt");
        fs::write(&path, "one\ntwo\n\n").unwrap();
        assert_eq!(count_untracked_lines(&path).additions, 3);

        fs::write(&path, [0, 1, 2]).unwrap();
        assert_eq!(count_untracked_lines(&path).additions, 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_untracked_file_from_nested_directory() {
        let root = std::env::temp_dir().join(format!("btmux-git-delete-{}", uuid::Uuid::new_v4()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let repo = Repository::init(&root).unwrap();
        let tracked = nested.join("tracked.txt");
        let untracked = nested.join("untracked.txt");
        fs::write(&tracked, "keep").unwrap();
        fs::write(&untracked, "delete").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("nested/tracked.txt")).unwrap();
        index.write().unwrap();

        assert!(git_delete_untracked_file_sync(&nested, "nested/tracked.txt").is_err());
        assert!(tracked.exists());
        git_delete_untracked_file_sync(&nested, "nested/untracked.txt").unwrap();
        assert!(!untracked.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_includes_staged_and_unstaged_line_counts() {
        let root = std::env::temp_dir().join(format!("btmux-git-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "one\n").unwrap();

        let repo = Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::write(&file, "one\ntwo\nthree\n").unwrap();
        let lightweight_status = git_status_sync(&root, false).unwrap();
        assert_eq!(lightweight_status.unstaged[0].additions, 0);

        let status = git_status_sync(&root, true).unwrap();
        assert_eq!(status.unstaged[0].path, "file.txt");
        assert_eq!(status.unstaged[0].additions, 2);
        assert_eq!(status.unstaged[0].deletions, 0);

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let status = git_status_sync(&root, true).unwrap();
        assert_eq!(status.staged[0].additions, 2);
        assert_eq!(status.staged[0].deletions, 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_of_nested_directory_matches_git_paths() {
        let root = std::env::temp_dir().join(format!("btmux-git-nested-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        // Resolved, like the roots browsers send.
        let inner = repo.workdir().unwrap().join("nested").join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("child.txt"), "one\n").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("nested/inner/child.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::write(inner.join("child.txt"), "two\n").unwrap();
        fs::write(inner.join("new.txt"), "new\n").unwrap();
        fs::write(root.join("outside.txt"), "outside\n").unwrap();

        let status = git_status_sync(&inner, false).unwrap();
        let unstaged: Vec<_> = status.unstaged.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(unstaged, ["nested/inner/child.txt"]);
        assert_eq!(status.untracked, ["nested/inner/new.txt"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staged_rename_is_reported_as_one_entry() {
        let root = std::env::temp_dir().join(format!("btmux-git-rename-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let content = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
        fs::write(root.join("old.txt"), content).unwrap();

        let repo = Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("old.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
        index.remove_path(Path::new("old.txt")).unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();

        let status = git_status_sync(&root, true).unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "new.txt");
        assert_eq!(status.staged[0].old_path.as_deref(), Some("old.txt"));
        assert!(matches!(
            status.staged[0].status,
            super::FileStatus::Renamed
        ));

        let diff = git_diff_file_sync(&root, "new.txt", true, false, 3).unwrap();
        assert_eq!(diff.old_path.as_deref(), Some("old.txt"));

        git_unstage_file_sync(&root, "new.txt").unwrap();
        let status = git_status_sync(&root, false).unwrap();
        assert!(status.staged.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diff_can_ignore_all_whitespace() {
        let root = std::env::temp_dir().join(format!("btmux-git-diff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "one two\nunchanged\n").unwrap();

        let repo = Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::write(&file, "one   two  \nunchanged\n").unwrap();

        let diff = git_diff_file_sync(&root, "file.txt", false, false, 3).unwrap();
        assert!(!diff.hunks.is_empty());

        let whitespace_ignored = git_diff_file_sync(&root, "file.txt", false, true, 3).unwrap();
        assert!(whitespace_ignored.hunks.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diff_uses_requested_context_lines() {
        let root = std::env::temp_dir().join(format!("btmux-git-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        let lines: Vec<String> = (1..=20).map(|n| format!("line {n}")).collect();
        fs::write(&file, lines.join("\n") + "\n").unwrap();

        let repo = Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        let mut changed = lines.clone();
        changed[9] = "changed".to_string();
        fs::write(&file, changed.join("\n") + "\n").unwrap();

        let context = |n| {
            let diff = git_diff_file_sync(&root, "file.txt", false, false, n).unwrap();
            diff.hunks[0]
                .lines
                .iter()
                .filter(|line| line.origin == ' ')
                .count()
        };
        assert_eq!(context(0), 0);
        assert_eq!(context(3), 6);
        assert_eq!(context(5), 10);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_uses_staged_changes_and_message_fields() {
        let root = std::env::temp_dir().join(format!("btmux-git-commit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "one\n").unwrap();

        let repo = Repository::init(&root).unwrap();
        // Without a global identity, as on CI.
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "btmux").unwrap();
        config.set_str("user.email", "btmux@example.com").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::write(&file, "one\ntwo\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        git_commit_sync(&root, "subject", "body\nline").unwrap();

        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(commit.message().unwrap(), "subject\n\nbody\nline");
        assert!(git_status_sync(&root, false).unwrap().staged.is_empty());

        assert_eq!(
            git_commit_sync(&root, "empty", "").unwrap_err(),
            "Nothing staged"
        );
        assert_eq!(
            repo.head().unwrap().peel_to_commit().unwrap().id(),
            commit.id()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_commit_requires_staged_files() {
        let root = std::env::temp_dir().join(format!("btmux-git-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("file.txt"), "one\n").unwrap();
        let repo = Repository::init(&root).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "btmux").unwrap();
        config.set_str("user.email", "btmux@example.com").unwrap();

        assert_eq!(
            git_commit_sync(&root, "empty", "").unwrap_err(),
            "Nothing staged"
        );
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        git_commit_sync(&root, "initial", "").unwrap();
        assert!(repo.head().is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_includes_commit_metadata_and_all_local_refs() {
        let root = std::env::temp_dir().join(format!("btmux-git-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "one\n").unwrap();

        let repo = Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.com").unwrap();
        let oid = repo
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();

        let log = git_log_sync(&root, 10).unwrap();
        assert_eq!(log.commits.len(), 1);
        assert!(!log.truncated);
        assert_eq!(log.commits[0].summary, "initial");
        assert_eq!(log.commits[0].author, "btmux");
        assert!(log.commits[0].is_head);
        assert!(log.commits[0]
            .refs
            .iter()
            .any(|reference| reference.name == "feature"));

        let diff = git_commit_diff_sync(&root, &oid.to_string(), 3).unwrap();
        assert_eq!(diff.commit_id, oid.to_string());
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].diff.path, "file.txt");
        assert_eq!(diff.files[0].diff.hunks[0].lines[0].origin, '+');

        fs::remove_dir_all(root).unwrap();
    }

    fn commit_all(root: &Path) -> String {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("btmux", "btmux@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "large", &tree, &[])
            .unwrap()
            .to_string()
    }

    fn shown_lines(file: &super::CommitFileDiff) -> usize {
        file.diff.hunks.iter().map(|hunk| hunk.lines.len()).sum()
    }

    #[test]
    fn commit_diff_caps_each_file_but_counts_all_lines() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        let extra = 5;
        let huge = "line\n".repeat(MAX_DIFF_FILE_LINES + extra);
        fs::write(root.join("a-huge.txt"), huge).unwrap();
        fs::write(root.join("b-small.txt"), "one\ntwo\n").unwrap();
        let id = commit_all(&root);

        let diff = git_commit_diff_sync(&root, &id, 3).unwrap();
        assert_eq!(diff.total_files, 2);
        assert_eq!(diff.additions, MAX_DIFF_FILE_LINES + extra + 2);
        let (huge, small) = (&diff.files[0], &diff.files[1]);
        assert!(huge.diff.truncated);
        assert_eq!(huge.additions, MAX_DIFF_FILE_LINES + extra);
        assert_eq!(shown_lines(huge), MAX_DIFF_FILE_LINES);
        assert!(!small.diff.truncated);
        assert_eq!(shown_lines(small), 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_diffs_cap_tracked_and_untracked_files() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        let count = MAX_DIFF_FILE_LINES + 5;
        fs::write(root.join("tracked.txt"), "old\n".repeat(count)).unwrap();
        fs::write(root.join("small.txt"), "old\n").unwrap();
        commit_all(&root);
        fs::write(root.join("tracked.txt"), "new\n".repeat(count)).unwrap();
        fs::write(root.join("small.txt"), "new\n").unwrap();
        fs::write(root.join("untracked.txt"), "new\n".repeat(count)).unwrap();

        let shown = |diff: &super::FileDiff| -> usize {
            diff.hunks.iter().map(|hunk| hunk.lines.len()).sum()
        };
        let tracked = git_diff_file_sync(&root, "tracked.txt", false, false, 3).unwrap();
        assert!(tracked.truncated);
        assert_eq!(shown(&tracked), MAX_DIFF_FILE_LINES);
        let untracked = git_diff_file_sync(&root, "untracked.txt", false, false, 3).unwrap();
        assert!(untracked.truncated);
        assert_eq!(shown(&untracked), MAX_DIFF_FILE_LINES);
        assert_eq!(
            untracked.hunks[0].header,
            format!("@@ -0,0 +1,{count} @@ new file")
        );
        assert!(
            !git_diff_file_sync(&root, "small.txt", false, false, 3)
                .unwrap()
                .truncated
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_diff_stops_at_the_commit_budgets() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        let count = MAX_COMMIT_DIFF_LINES / MAX_DIFF_FILE_LINES + 2;
        let text = "line\n".repeat(MAX_DIFF_FILE_LINES);
        for index in 0..count {
            fs::write(root.join(format!("{index:02}.txt")), &text).unwrap();
        }
        let id = commit_all(&root);

        let diff = git_commit_diff_sync(&root, &id, 3).unwrap();
        assert_eq!(diff.additions, count * MAX_DIFF_FILE_LINES);
        assert_eq!(
            diff.files.iter().map(shown_lines).sum::<usize>(),
            MAX_COMMIT_DIFF_LINES
        );
        let last = diff.files.last().unwrap();
        assert!(last.diff.truncated && last.diff.hunks.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_diff_caps_files_and_long_lines() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        for index in 0..=MAX_COMMIT_DIFF_FILES {
            fs::write(root.join(format!("{index:04}.txt")), "one\n").unwrap();
        }
        // The cap lands inside a multibyte character.
        let long = format!(
            "{}é{}\n",
            "x".repeat(MAX_DIFF_LINE_BYTES - 1),
            "y".repeat(9)
        );
        fs::write(root.join("0000.txt"), long).unwrap();
        let id = commit_all(&root);

        let diff = git_commit_diff_sync(&root, &id, 3).unwrap();
        assert_eq!(diff.total_files, MAX_COMMIT_DIFF_FILES + 1);
        assert_eq!(diff.additions, MAX_COMMIT_DIFF_FILES + 1);
        assert_eq!(diff.files.len(), MAX_COMMIT_DIFF_FILES);
        let content = &diff.files[0].diff.hunks[0].lines[0].content;
        assert_eq!(
            *content,
            format!("{}…", "x".repeat(MAX_DIFF_LINE_BYTES - 1))
        );
        assert!(diff.files[0].diff.truncated);
        assert!(!diff.files[1].diff.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tracked_binary_change_is_reported_as_binary() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        fs::write(root.join("image.bin"), [0u8, 1, 2]).unwrap();
        commit_all(&root);
        fs::write(root.join("image.bin"), [0u8, 3, 4]).unwrap();

        let diff = git_diff_file_sync(&root, "image.bin", false, false, 3).unwrap();
        assert!(diff.is_binary);
        assert!(diff.hunks.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn byte_budget_counts_replacement_characters() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        // Half the budget in bytes, 1.5 times it once each byte becomes U+FFFD.
        let mut line = vec![0xE9u8; 999];
        line.push(b'\n');
        fs::write(root.join("latin1.txt"), line.repeat(MAX_DIFF_BYTES / 2000)).unwrap();
        let id = commit_all(&root);

        let diff = git_commit_diff_sync(&root, &id, 3).unwrap();
        let file = &diff.files[0].diff;
        assert!(!file.is_binary);
        assert!(file.truncated);
        let sent: usize = file
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .map(|line| line.content.len())
            .sum();
        assert!(sent <= MAX_DIFF_BYTES);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shortened_lines_mark_diffs_truncated_and_keep_later_rows() {
        let root = std::env::temp_dir().join(format!("btmux-git-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        let long = |tail: &str| format!("{}{tail}\nnext\n", "x".repeat(MAX_DIFF_LINE_BYTES));
        // Git counts the newline.
        let fits = format!("{}\n", "x".repeat(MAX_DIFF_LINE_BYTES - 1));
        let has_next = |diff: &super::FileDiff| {
            diff.hunks
                .iter()
                .flat_map(|hunk| &hunk.lines)
                .any(|line| line.content == "next\n")
        };

        fs::write(root.join("fits.txt"), &fits).unwrap();
        fs::write(root.join("tracked.txt"), long("OLD")).unwrap();
        let id = commit_all(&root);
        let commit = git_commit_diff_sync(&root, &id, 3).unwrap();
        let (fits_file, tracked_file) = (&commit.files[0].diff, &commit.files[1].diff);
        assert!(!fits_file.truncated);
        assert!(tracked_file.truncated && has_next(tracked_file));

        fs::write(root.join("fits.txt"), format!("{fits}{fits}")).unwrap();
        fs::write(root.join("tracked.txt"), long("NEW")).unwrap();
        fs::write(root.join("untracked.txt"), long("NEW")).unwrap();
        fs::write(root.join("untracked-fits.txt"), &fits).unwrap();
        for (path, truncated) in [
            ("fits.txt", false),
            ("tracked.txt", true),
            ("untracked.txt", true),
            ("untracked-fits.txt", false),
        ] {
            let diff = git_diff_file_sync(&root, path, false, false, 3).unwrap();
            assert_eq!(diff.truncated, truncated, "{path}");
            assert_eq!(has_next(&diff), truncated, "{path}");
        }

        fs::remove_dir_all(root).unwrap();
    }
}
