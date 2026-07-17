use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// A git repo discovered under a base directory, resolved into the windows a
/// btmux session should get. Produced by `discover_repo_layouts`, which shells
/// out to `git` — run it on a blocking thread so the subprocess calls don't
/// stall the async runtime.
pub struct RepoLayout {
    /// Sanitized repo directory name → session name.
    pub name: String,
    /// One window per worktree: (sanitized worktree folder name, worktree path).
    /// Empty when the repo has no named worktree branches (detached/bare); the
    /// caller then makes a single window at `root`.
    pub windows: Vec<(String, PathBuf)>,
    /// Repo root, used as the single-window cwd when `windows` is empty.
    pub root: PathBuf,
}

/// Result of `discover`: either the active pane is already inside a repo
/// (add windows to the current session) or the directory contains child repos
/// (create one session per repo).
pub enum Discovery {
    /// The base dir is inside this repo; add its worktrees as windows.
    InsideRepo(RepoLayout),
    /// Zero or more child repos found one level below the base dir.
    ChildRepos(Vec<RepoLayout>),
}

/// Top-level entry point. If `base_dir` is inside a git repo, returns
/// `InsideRepo`; otherwise scans immediate children for repos and returns
/// `ChildRepos`. Blocking — call from a blocking context.
pub fn discover(base_dir: &Path) -> Discovery {
    if let Some(root) = find_git_root(base_dir) {
        Discovery::InsideRepo(repo_layout_for(root))
    } else {
        Discovery::ChildRepos(discover_child_repo_layouts(base_dir))
    }
}

/// Walk up from `path` looking for a `.git` directory, using `git rev-parse`.
fn find_git_root(path: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .args([
            "-C",
            path.to_str().unwrap_or("."),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .ok()?;
    if output.status.success() {
        let s = std::str::from_utf8(&output.stdout).ok()?.trim();
        Some(PathBuf::from(s))
    } else {
        None
    }
}

fn repo_layout_for(repo: PathBuf) -> RepoLayout {
    let name = repo
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_name)
        .unwrap_or_else(|| "repo".to_string());
    let windows = match list_worktrees(&repo) {
        Ok(wts) => wts
            .into_iter()
            .filter_map(|wt| {
                // Skip the bare repo entry and detached-HEAD worktrees (no
                // branch), matching the previous behavior; name the window
                // after the folder the worktree lives in, not the branch.
                wt.branch?;
                let name = wt
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(sanitize_name)?;
                Some((name, wt.path))
            })
            .collect(),
        Err(e) => {
            tracing::warn!("{}: git worktree list failed: {}", name, e);
            Vec::new()
        }
    };
    RepoLayout {
        name,
        windows,
        root: repo,
    }
}

/// Discover git repos under `base_dir` and resolve each one's worktrees into a
/// `RepoLayout`. Skips children that are themselves inside a git repo (avoids
/// nested-repo confusion). Blocking — call from a blocking context.
fn discover_child_repo_layouts(base_dir: &Path) -> Vec<RepoLayout> {
    let Ok(entries) = std::fs::read_dir(base_dir) else {
        return Vec::new();
    };
    let mut repos: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").is_dir())
        .collect();
    repos.sort();
    repos.into_iter().map(repo_layout_for).collect()
}

/// Run `git -C <repo> worktree list --porcelain` and parse the result.
pub fn list_worktrees(repo: &Path) -> Result<Vec<Worktree>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            repo.to_str().unwrap_or("."),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_porcelain(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_porcelain(output: &str) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;

    for line in output.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(prev) = path.take() {
                worktrees.push(Worktree {
                    path: prev,
                    branch: branch.take(),
                });
            }
            path = Some(PathBuf::from(p));
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            branch = Some(b.to_string());
        }
    }
    if let Some(p) = path {
        worktrees.push(Worktree { path: p, branch });
    }
    worktrees
}

/// Sanitize a string for use as a btmux session or window name (replace `.`, `:`, whitespace with `-`).
pub fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c == '.' || c == ':' || c.is_whitespace() {
                '-'
            } else {
                c
            }
        })
        .collect()
}
