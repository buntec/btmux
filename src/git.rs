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
    /// One window per worktree branch: (sanitized branch name, worktree path).
    /// Empty when the repo has no named worktree branches (detached/bare); the
    /// caller then makes a single window at `root`.
    pub windows: Vec<(String, PathBuf)>,
    /// Repo root, used as the single-window cwd when `windows` is empty.
    pub root: PathBuf,
}

/// Discover git repos under `base_dir` and resolve each one's worktrees into a
/// `RepoLayout`. Blocking (reads the directory and runs `git worktree list` per
/// repo) — call from a blocking context. A repo whose `git worktree list` fails
/// is kept with no windows (the caller falls back to a single window at root).
pub fn discover_repo_layouts(base_dir: &Path) -> Vec<RepoLayout> {
    discover_repos(base_dir)
        .into_iter()
        .map(|repo| {
            let name = repo
                .file_name()
                .and_then(|n| n.to_str())
                .map(sanitize_name)
                .unwrap_or_else(|| "repo".to_string());
            let windows = match list_worktrees(&repo) {
                Ok(wts) => wts
                    .into_iter()
                    .filter_map(|wt| wt.branch.map(|b| (sanitize_name(&b), wt.path)))
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
        })
        .collect()
}

/// Return immediate child directories of `root` that contain a `.git` entry.
pub fn discover_repos(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut repos: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").is_dir())
        .collect();
    repos.sort();
    repos
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
