use git2::{DiffOptions, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitHead {
    pub branch: Option<String>,
    pub commit_sha: String,
    pub commit_message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub head: GitHead,
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub untracked: Vec<String>,
    pub is_repo: bool,
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

pub async fn git_status(root: &Path) -> Result<GitStatusResult, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || git_status_sync(&root))
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

fn open_repo(root: &Path) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("Not a git repository: {}", e))
}

fn git_status_sync(root: &Path) -> Result<GitStatusResult, String> {
    let repo = match Repository::discover(root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitStatusResult {
                head: GitHead {
                    branch: None,
                    commit_sha: String::new(),
                    commit_message: String::new(),
                },
                staged: vec![],
                unstaged: vec![],
                untracked: vec![],
                is_repo: false,
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

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

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
            });
        }

        if st.intersects(
            Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE | Status::WT_RENAMED,
        ) {
            unstaged.push(StatusEntry {
                path: path.clone(),
                status: wt_status_to_enum(st),
                old_path: None,
            });
        }
    }

    Ok(GitStatusResult {
        head,
        staged,
        unstaged,
        untracked,
        is_repo: true,
    })
}

fn get_head_info(repo: &Repository) -> GitHead {
    let branch = repo
        .head()
        .ok()
        .and_then(|r| r.shorthand().map(|s| s.to_string()));

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
