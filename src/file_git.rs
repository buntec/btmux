use git2::{
    BranchType, DiffDelta, DiffHunk as GitDiffHunk, DiffLine as GitDiffLine, DiffOptions,
    ErrorCode, Repository, Status, StatusOptions,
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
}

pub async fn git_status(root: &Path, include_diff_stats: bool) -> Result<GitStatusResult, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || git_status_sync(&root, include_diff_stats))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn git_diff_file(root: &Path, path: &str, staged: bool) -> Result<FileDiff, String> {
    let root = root.to_path_buf();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || git_diff_file_sync(&root, &path, staged))
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
            });
        }
    };

    let prefix = repo
        .workdir()
        .and_then(|wd| root.strip_prefix(wd).ok())
        .map(|p| {
            let s = p.to_string_lossy().to_string();
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
        .include_unmodified(false);
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
            staged.push(StatusEntry {
                path: path.clone(),
                status: index_status_to_enum(st),
                old_path: None,
                additions: staged_stats.get(&path).map_or(0, |stats| stats.additions),
                deletions: staged_stats.get(&path).map_or(0, |stats| stats.deletions),
            });
        }

        if st.intersects(
            Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE | Status::WT_RENAMED,
        ) {
            unstaged.push(StatusEntry {
                path: path.clone(),
                status: wt_status_to_enum(st),
                old_path: None,
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
    })
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
        let head_tree = repo
            .head()
            .ok()
            .and_then(|reference| reference.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
    }
    .map_err(|e| format!("Failed to get diff stats: {}", e))?;

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
        .and_then(|r| r.shorthand().map(|s| s.to_string()));

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
                c.summary().unwrap_or("").to_string(),
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
    let lines: Vec<DiffLine> = content
        .lines()
        .map(|l| DiffLine {
            origin: '+',
            content: format!("{}\n", l),
        })
        .collect();
    let num_lines = lines.len() as u32;
    Ok(FileDiff {
        path: path.to_string(),
        old_path: None,
        hunks: vec![DiffHunk {
            header: format!("@@ -0,0 +1,{} @@ new file", num_lines),
            old_start: 0,
            new_start: 1,
            lines,
        }],
        is_binary: false,
    })
}

fn git_diff_file_sync(root: &Path, path: &str, staged: bool) -> Result<FileDiff, String> {
    let repo = open_repo(root)?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.pathspec(path);

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
        let head_tree = repo.head().ok().and_then(|r| r.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
    }
    .map_err(|e| format!("Failed to get diff: {}", e))?;

    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut is_binary = false;
    let mut diff_path = path.to_string();
    let mut old_path: Option<String> = None;

    let num_deltas = diff.deltas().len();
    for delta_idx in 0..num_deltas {
        let delta = diff.deltas().nth(delta_idx).unwrap();
        is_binary = delta.flags().is_binary();
        if let Some(p) = delta.new_file().path() {
            diff_path = p.to_string_lossy().to_string();
        }
        if let Some(p) = delta.old_file().path() {
            let old = p.to_string_lossy().to_string();
            if old != diff_path {
                old_path = Some(old);
            }
        }
    }

    let mut patch_idx = 0;
    while let Ok(Some(patch)) = git2::Patch::from_diff(&diff, patch_idx) {
        let num_hunks = patch.num_hunks();
        for hunk_idx in 0..num_hunks {
            let (hunk, _num_lines) = patch
                .hunk(hunk_idx)
                .map_err(|e| format!("Failed to get hunk: {}", e))?;

            let mut lines = Vec::new();
            let num_lines_in_hunk = patch
                .num_lines_in_hunk(hunk_idx)
                .map_err(|e| format!("Failed to get line count: {}", e))?;

            for line_idx in 0..num_lines_in_hunk {
                let line = patch
                    .line_in_hunk(hunk_idx, line_idx)
                    .map_err(|e| format!("Failed to get line: {}", e))?;
                lines.push(DiffLine {
                    origin: line.origin(),
                    content: String::from_utf8_lossy(line.content()).to_string(),
                });
            }

            hunks.push(DiffHunk {
                header: String::from_utf8_lossy(hunk.header()).trim().to_string(),
                old_start: hunk.old_start(),
                new_start: hunk.new_start(),
                lines,
            });
        }
        patch_idx += 1;
    }

    Ok(FileDiff {
        path: diff_path,
        old_path,
        hunks,
        is_binary,
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

    repo.reset_default(Some(head.as_object()), [path])
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
    use super::{count_untracked_lines, git_commit_sync, git_status_sync};
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
    fn commit_uses_staged_changes_and_message_fields() {
        let root = std::env::temp_dir().join(format!("btmux-git-commit-{}", uuid::Uuid::new_v4()));
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

        fs::write(&file, "one\ntwo\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        git_commit_sync(&root, "subject", "body\nline").unwrap();

        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(commit.message().unwrap(), "subject\n\nbody\nline");
        assert!(git_status_sync(&root, false).unwrap().staged.is_empty());

        fs::remove_dir_all(root).unwrap();
    }
}
