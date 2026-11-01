//! Git worktree creation and removal for panes, shared by the control socket,
//! REST, MCP, and the CLI. Runs the `git` CLI so hooks and config apply.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::automation::Error;
use crate::ws::control::broadcast_state;
use crate::AppState;

/// `worktree-path` default: a sibling of the main worktree.
pub const DEFAULT_PATH: &str = "{repo}-{branch}";

#[derive(Serialize)]
pub struct Created {
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub path: String,
    pub branch: String,
}

#[derive(Serialize)]
pub struct Removed {
    pub path: String,
    pub branch: Option<String>,
    pub closed_panes: Vec<Uuid>,
}

/// A worktree as git mode lists it.
#[derive(Debug, Serialize)]
pub struct Info {
    /// The root, with symlinks resolved as in `PaneGit::worktree_root`.
    pub path: String,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Empty for a bare repo or an unborn branch.
    pub head: String,
    pub subject: String,
    pub main: bool,
    pub bare: bool,
    /// Contains the directory it was listed from.
    pub current: bool,
    /// The lock reason, possibly empty.
    pub locked: Option<String>,
    /// Its directory is gone; `git worktree prune` removes it.
    pub prunable: bool,
}

/// Git mode's worktree operations, run in a directory of the repo.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Op {
    /// Add a worktree; `visit` also opens a window there and selects it.
    Add {
        branch: String,
        /// A remote branch (`origin/x`) for a new `branch` to track.
        #[serde(default)]
        track: Option<String>,
        #[serde(default)]
        visit: bool,
    },
    /// Open a window in the worktree at `path` and select it.
    Open {
        path: String,
    },
    Remove {
        path: String,
        /// Discard uncommitted changes, like `git worktree remove --force`.
        #[serde(default)]
        force: bool,
    },
    Lock {
        path: String,
    },
    Unlock {
        path: String,
    },
    Prune,
}

impl Op {
    /// Whether it ends with a window of the worktree selected.
    pub fn navigates(&self) -> bool {
        matches!(self, Op::Open { .. } | Op::Add { visit: true, .. })
    }
}

/// Run `op` from `dir`, opening windows in `session_id`. Returns a summary.
pub async fn run(
    state: &AppState,
    session_id: Option<Uuid>,
    dir: &Path,
    op: Op,
) -> Result<String, Error> {
    let session = || session_id.ok_or_else(|| Error::Invalid("Missing session".into()));
    match op {
        Op::Add {
            branch,
            track,
            visit,
        } if visit => {
            let created =
                create_in(state, session()?, dir, &branch, track.as_deref(), true).await?;
            Ok(format!("Created {}", created.path))
        }
        Op::Add { branch, track, .. } => {
            let (path, _) = add_async(state, dir, &branch, track.as_deref()).await?;
            Ok(format!("Created {}", path.display()))
        }
        Op::Open { path } => {
            let path = listed(dir, path).await?;
            open(state, session()?, &path).await?;
            Ok(String::new())
        }
        Op::Remove { path, force } => {
            let path = listed(dir, path).await?;
            let removed = remove_at(state, &path, force).await?;
            let panes = removed.closed_panes.len();
            Ok(match panes {
                0 => format!("Removed {}", removed.path),
                1 => format!("Removed {} and closed its pane", removed.path),
                n => format!("Removed {} and closed its {n} panes", removed.path),
            })
        }
        // The list shows the result.
        Op::Lock { path } => {
            blocking(dir, move |dir| {
                git(dir, &[&"worktree", &"lock", &"--", &path])
            })
            .await
        }
        Op::Unlock { path } => {
            blocking(dir, move |dir| {
                git(dir, &[&"worktree", &"unlock", &"--", &path])
            })
            .await
        }
        // `--verbose` reports on stderr, so count instead.
        Op::Prune => {
            blocking(dir, |dir| {
                let before = records(dir)?.len();
                git(dir, &[&"worktree", &"prune"])?;
                Ok(match before.saturating_sub(records(dir)?.len()) {
                    0 => "Nothing to prune".into(),
                    1 => "Pruned 1 worktree".into(),
                    n => format!("Pruned {n} worktrees"),
                })
            })
            .await
        }
    }
}

/// `path`, if it's the root of a worktree of the repo containing `dir`, as
/// [`list_in`] spells it. An op on it then never resolves to an enclosing
/// worktree (`path` is gone) or another repo's (a faked record).
async fn listed(dir: &Path, path: String) -> Result<PathBuf, Error> {
    blocking(dir, move |dir| {
        let not_listed = || format!("{path} is not a worktree of this repo");
        if !records(dir)?
            .iter()
            .any(|record| listed_path(&record.path) == path)
        {
            return Err(not_listed());
        }
        let common = git2::Repository::discover(dir)
            .map_err(|e| e.message().to_string())?
            .commondir()
            .to_path_buf();
        let common = common.canonicalize().unwrap_or(common);
        match crate::pane_git::worktree_of(Path::new(&path)) {
            Some((git, _))
                if git.worktree_root == path && Path::new(&git.repo_id) == common.as_path() =>
            {
                Ok(path)
            }
            _ => Err(not_listed()),
        }
    })
    .await
    .map(PathBuf::from)
}

/// A record of `git worktree list --porcelain`.
#[derive(Debug, Default)]
pub struct Record {
    /// As git spells it.
    pub path: String,
    /// Empty for a bare repo or an unborn branch.
    pub head: String,
    /// Without `refs/heads/`; `None` when HEAD is detached.
    pub branch: Option<String>,
    pub bare: bool,
    /// The lock reason, possibly empty.
    pub locked: Option<String>,
    pub prunable: bool,
}

/// The worktrees git lists from `dir`, the main one first.
pub fn records(dir: &Path) -> Result<Vec<Record>, String> {
    // NUL-delimited, as paths may contain newlines.
    let Ok(output) = git(dir, &[&"worktree", &"list", &"--porcelain", &"-z"]) else {
        // git before 2.36 lacks `-z`. A path or lock reason with a newline
        // can fake a record there; one naming a worktree of the repo repeats
        // its path, and ops check others with [`listed`].
        let output = git(dir, &[&"worktree", &"list", &"--porcelain"])?;
        return unambiguous(parse_records(&output, '\n'));
    };
    Ok(parse_records(&output, '\0'))
}

/// `records`, unless two share a path.
fn unambiguous(records: Vec<Record>) -> Result<Vec<Record>, String> {
    let mut paths: Vec<_> = records.iter().map(|record| &record.path).collect();
    paths.sort();
    if paths.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("A worktree path contains a newline; listing it needs git 2.36".into());
    }
    Ok(records)
}

/// Porcelain fields delimited by `end`, with an empty field ending a record.
fn parse_records(output: &str, end: char) -> Vec<Record> {
    let mut records = Vec::new();
    let mut record: Option<Record> = None;
    for field in output.split(end) {
        if field.is_empty() {
            records.extend(record.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        let record = record.get_or_insert_with(Record::default);
        match key {
            "worktree" => record.path = value.to_string(),
            "HEAD" => record.head = value.to_string(),
            "branch" => {
                let branch = value.strip_prefix("refs/heads/").unwrap_or(value);
                record.branch = Some(branch.to_string());
            }
            "bare" => record.bare = true,
            "locked" => record.locked = Some(value.to_string()),
            "prunable" => record.prunable = true,
            _ => {}
        }
    }
    records.extend(record);
    records.retain(|record| !record.path.is_empty());
    records
}

async fn blocking(
    dir: &Path,
    f: impl FnOnce(&Path) -> Result<String, String> + Send + 'static,
) -> Result<String, Error> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || f(&dir))
        .await
        .map_err(|e| Error::Failed(e.to_string()))?
        .map_err(Error::Failed)
}

/// The worktrees of `repo`, which contains `dir`, the main one first.
pub fn list_in(repo: &git2::Repository, dir: &Path) -> Result<Vec<Info>, String> {
    let current = crate::pane_git::worktree_of(dir).map(|(git, _)| git.worktree_root);
    Ok(records(dir)?
        .into_iter()
        .enumerate()
        .map(|(index, record)| {
            let path = listed_path(&record.path);
            let subject = git2::Oid::from_str(&record.head)
                .ok()
                .and_then(|oid| repo.find_commit(oid).ok())
                .and_then(|commit| commit.summary().ok().flatten().map(str::to_string))
                .unwrap_or_default();
            Info {
                current: current.as_deref() == Some(path.as_str()),
                path,
                branch: record.branch,
                head: record.head,
                subject,
                main: index == 0,
                bare: record.bare,
                locked: record.locked,
                prunable: record.prunable,
            }
        })
        .collect())
}

/// A path from `git worktree list`, spelled as `pane_git` spells roots.
fn listed_path(path: &str) -> String {
    #[cfg(windows)]
    let path = path.replace('/', "\\");
    crate::pane_git::real_path(Path::new(&path))
        .to_string_lossy()
        .into_owned()
}

/// Create a worktree for `branch` in the repo of `pane_id`'s directory and
/// open a window there, in the pane's session. An existing local or remote
/// branch is checked out; otherwise it's created from the pane's HEAD.
pub async fn create(
    state: &AppState,
    pane_id: Uuid,
    branch: &str,
    select: bool,
) -> Result<Created, Error> {
    let (session_id, cwd) = {
        let mgr = state.read().await;
        let session_id = mgr
            .session_of_pane(pane_id)
            .ok_or(Error::PaneNotFound(pane_id))?;
        let cwd = mgr.find_pane(pane_id).and_then(|p| p.pty.local_cwd());
        (session_id, cwd)
    };
    let cwd = cwd.ok_or_else(|| Error::Conflict("The pane has no local directory".into()))?;
    create_in(state, session_id, Path::new(&cwd), branch, None, select).await
}

/// [`create`] from `dir`, with the window in `session_id`, tracking the
/// remote branch `track` if given.
pub async fn create_in(
    state: &AppState,
    session_id: Uuid,
    dir: &Path,
    branch: &str,
    track: Option<&str>,
    select: bool,
) -> Result<Created, Error> {
    if !state.read().await.has_session(session_id) {
        return Err(Error::Conflict("The session no longer exists".into()));
    }
    let (path, branch) = add_async(state, dir, branch, track).await?;
    let name = crate::git::sanitize_name(&branch);
    let mut mgr = state.write().await;
    let pane_id = mgr
        .create_window_named(session_id, Some(name), Some(path.clone()), select)
        .await
        .ok_or_else(|| Error::Conflict("The session no longer exists".into()))?;
    broadcast_state(&mgr);
    Ok(Created {
        session_id,
        pane_id,
        path: path.to_string_lossy().into_owned(),
        branch,
    })
}

/// [`add`] off the lock, with the configured path template.
async fn add_async(
    state: &AppState,
    dir: &Path,
    branch: &str,
    track: Option<&str>,
) -> Result<(PathBuf, String), Error> {
    let template = state.read().await.worktree_path_template();
    let (dir, branch) = (dir.to_path_buf(), branch.trim().to_string());
    let track = track.map(|track| track.trim().to_string());
    tokio::task::spawn_blocking(move || add(&dir, &branch, track.as_deref(), &template))
        .await
        .map_err(|e| Error::Failed(e.to_string()))?
}

/// Open a window in `session_id` at the root of the worktree containing
/// `dir`, named for its branch, and select it.
pub async fn open(state: &AppState, session_id: Uuid, dir: &Path) -> Result<Uuid, Error> {
    let dir = dir.to_path_buf();
    let (git, _) = tokio::task::spawn_blocking(move || crate::pane_git::worktree_of(&dir))
        .await
        .map_err(|e| Error::Failed(e.to_string()))?
        .ok_or_else(|| Error::Conflict("Not a git worktree".into()))?;
    let root = PathBuf::from(&git.worktree_root);
    let name = match &git.branch {
        Some(branch) => branch.clone(),
        None => root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| git.repo_name.clone()),
    };
    let mut mgr = state.write().await;
    let pane_id = mgr
        .create_window_named(
            session_id,
            Some(crate::git::sanitize_name(&name)),
            Some(root),
            true,
        )
        .await
        .ok_or_else(|| Error::Conflict("The session no longer exists".into()))?;
    broadcast_state(&mgr);
    Ok(pane_id)
}

/// Remove the linked worktree containing `pane_id`'s directory, closing every
/// pane in it. Refuses a main, dirty, or locked worktree, one with
/// submodules, and panes running a program. The branch is kept.
pub async fn remove(state: &AppState, pane_id: Uuid) -> Result<Removed, Error> {
    let cwd = {
        let mgr = state.read().await;
        let pane = mgr.find_pane(pane_id).ok_or(Error::PaneNotFound(pane_id))?;
        pane.pty.local_cwd()
    };
    let cwd = cwd.ok_or_else(|| Error::Conflict("The pane has no local directory".into()))?;
    remove_at(state, Path::new(&cwd), false).await
}

/// [`remove`] for the worktree containing `dir`. `force` also removes one
/// with uncommitted changes or submodules.
pub async fn remove_at(state: &AppState, dir: &Path, force: bool) -> Result<Removed, Error> {
    let dir = dir.to_path_buf();
    let target = tokio::task::spawn_blocking(move || removable(&dir, force))
        .await
        .map_err(|e| Error::Failed(e.to_string()))??;

    // Close the panes first: a shell's directory blocks removal on Windows.
    let closed_panes = {
        let mut mgr = state.write().await;
        let panes = mgr.panes_under(&[&target.root]);
        for &id in &panes {
            let pane = mgr.find_pane(id).unwrap();
            if let Some(program) = pane.pty.foreground_program() {
                // The `btmux remove-worktree` asking for this.
                if program != "btmux" {
                    return Err(Error::Conflict(format!(
                        "A pane in {} is running {program}",
                        target.root.display()
                    )));
                }
            }
        }
        for &id in &panes {
            mgr.handle_pane_exit(id).await;
        }
        broadcast_state(&mgr);
        panes
    };

    let root = target.root.clone();
    let common_dir = target.common_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&dyn AsRef<OsStr>> = vec![&"worktree", &"remove"];
        if force {
            args.push(&"--force");
        }
        args.extend([&"--" as &dyn AsRef<OsStr>, &root]);
        git(&common_dir, &args)
    })
    .await
    .map_err(|e| Error::Failed(e.to_string()))?
    .map_err(|e| Error::Failed(format!("{e} (its panes were closed)")))?;
    Ok(Removed {
        path: target.root.to_string_lossy().into_owned(),
        branch: target.branch,
        closed_panes,
    })
}

/// Add the worktree; returns its path and the branch name git resolved.
/// With `track`, a new `branch` tracks that remote branch; an existing one
/// must already track it.
fn add(
    dir: &Path,
    branch: &str,
    track: Option<&str>,
    template: &str,
) -> Result<(PathBuf, String), Error> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(Error::Invalid(format!("Invalid branch name: {branch:?}")));
    }
    let branch = git(dir, &[&"check-ref-format", &"--branch", &branch])
        .map_err(|_| Error::Invalid(format!("Invalid branch name: {branch:?}")))?;
    let common = git(
        dir,
        &[&"rev-parse", &"--path-format=absolute", &"--git-common-dir"],
    )?;
    let main = records(dir)?
        .into_iter()
        .next()
        .ok_or("git listed no worktrees")?
        .path;
    let repo = crate::pane_git::repo_name(Path::new(&common));
    let path = worktree_path(template, Path::new(&main), &repo, &branch);
    if path.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            path.display()
        )));
    }

    let local_ref = format!("refs/heads/{branch}");
    let local = git(dir, &[&"show-ref", &"--verify", &"--quiet", &local_ref]).is_ok();
    if let Some(track) = track {
        let remote_ref = format!("refs/remotes/{track}");
        if track.starts_with('-')
            || git(dir, &[&"show-ref", &"--verify", &"--quiet", &remote_ref]).is_err()
        {
            return Err(Error::Invalid(format!("No remote branch {track:?}")));
        }
        if local {
            let upstream = git(
                dir,
                &[&"for-each-ref", &"--format=%(upstream)", &"--", &local_ref],
            )?;
            if upstream != remote_ref {
                return Err(Error::Conflict(format!(
                    "Local branch {branch} exists and doesn't track {track}"
                )));
            }
            git(dir, &[&"worktree", &"add", &"--", &path, &branch])?;
        } else {
            git(
                dir,
                &[
                    &"worktree",
                    &"add",
                    &"--track",
                    &"-b",
                    &branch,
                    &"--",
                    &path,
                    &track,
                ],
            )?;
        }
        return Ok((path, branch));
    }
    let remote = git(
        dir,
        &[
            &"for-each-ref",
            &"--format=%(refname:strip=2)",
            &"refs/remotes",
        ],
    )?
    .lines()
    .any(|r| r.split_once('/').is_some_and(|(_, name)| name == branch));
    if local || remote {
        // A remote branch is checked out as a new tracking branch.
        git(dir, &[&"worktree", &"add", &"--", &path, &branch])?;
    } else {
        git(dir, &[&"worktree", &"add", &"-b", &branch, &"--", &path])?;
    }
    Ok((path, branch))
}

/// `template` with `{repo}` and `{branch}` (slashes as dashes) filled in,
/// relative to the main worktree's parent unless absolute or `~/`.
fn worktree_path(template: &str, main: &Path, repo: &str, branch: &str) -> PathBuf {
    let path = template
        .replace("{repo}", repo)
        .replace("{branch}", &branch.replace('/', "-"));
    if let (Some(rest), Some(home)) = (path.strip_prefix("~/"), dirs::home_dir()) {
        return home.join(rest);
    }
    main.parent().unwrap_or(main).join(path)
}

struct Target {
    root: PathBuf,
    /// Where git runs: a process in `root` blocks its removal on Windows.
    common_dir: PathBuf,
    branch: Option<String>,
}

/// The linked worktree containing `dir`, if git would remove it (with
/// `--force` when `force`).
fn removable(dir: &Path, force: bool) -> Result<Target, Error> {
    let (git_info, git_dir) = crate::pane_git::worktree_of(dir)
        .ok_or_else(|| Error::Conflict("The pane isn't in a git worktree".into()))?;
    let root = PathBuf::from(&git_info.worktree_root);
    if git_info.main_worktree {
        return Err(Error::Conflict(format!(
            "{} is the repo's main worktree",
            root.display()
        )));
    }
    if git_dir.join("locked").exists() {
        return Err(Error::Conflict(format!("{} is locked", root.display())));
    }
    let common_dir = PathBuf::from(git(
        &root,
        &[&"rev-parse", &"--path-format=absolute", &"--git-common-dir"],
    )?);
    if force {
        return Ok(Target {
            root,
            common_dir,
            branch: git_info.branch,
        });
    }
    // Explicit, as `status.showUntrackedFiles=no` would hide untracked files
    // that removal deletes.
    let status = git(
        &root,
        &[&"status", &"--porcelain", &"--untracked-files=normal"],
    )?;
    if !status.is_empty() {
        return Err(Error::Conflict(format!(
            "{} has uncommitted changes",
            root.display()
        )));
    }
    if has_submodules(&root, &git_dir)? {
        return Err(Error::Conflict(format!(
            "{} contains submodules",
            root.display()
        )));
    }
    Ok(Target {
        root,
        common_dir,
        branch: git_info.branch,
    })
}

/// Whether git refuses to remove the worktree for its submodules, as
/// `validate_no_submodules` decides: a `modules` git dir, or a populated
/// gitlink.
fn has_submodules(root: &Path, git_dir: &Path) -> Result<bool, Error> {
    if git_dir.join("modules").is_dir() {
        return Ok(true);
    }
    let index = git(root, &[&"ls-files", &"--stage", &"-z"])?;
    Ok(index
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("160000 ")?.split_once('\t'))
        .any(|(_, path)| root.join(path).join(".git").exists()))
}

/// Run git in `dir`. Returns trimmed stdout, or git's message.
fn git(dir: &Path, args: &[&dyn AsRef<OsStr>]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args.iter().map(|arg| arg.as_ref()))
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        "git failed".into()
    } else {
        message
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FileConfig;
    use crate::session::manager::SessionManager;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    struct Repo {
        dir: PathBuf,
        main: PathBuf,
    }

    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("btmux-worktree-{}", Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("proj")).unwrap();
            // Spelled as worktree roots (`TEMP` may hold 8.3 names).
            let dir = crate::pane_git::real_path(&dir);
            let main = dir.join("proj");
            run(&main, &["init", "-q", "-b", "main"]);
            run(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
            Self { dir, main }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn run(dir: &Path, args: &[&str]) {
        let mut all: Vec<&dyn AsRef<OsStr>> = vec![&"-c", &"user.name=t", &"-c", &"user.email=t@t"];
        all.extend(args.iter().map(|a| a as &dyn AsRef<OsStr>));
        git(dir, &all).unwrap();
    }

    /// A server with an unspawned pane in each of `dirs`.
    async fn panes(dirs: &[&Path]) -> (AppState, Vec<Uuid>) {
        let (exit_tx, _) = mpsc::unbounded_channel();
        let (meta_tx, _) = mpsc::unbounded_channel();
        let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        let mut mgr = SessionManager::new(
            shell.into(),
            FileConfig::default(),
            exit_tx,
            meta_tx,
            8044,
            None,
        );
        let session = mgr.create_session(None).await;
        let mut panes = Vec::new();
        for dir in dirs {
            let pane = mgr.create_window_named(session, None, Some(dir.to_path_buf()), false);
            panes.push(pane.await.unwrap());
        }
        (Arc::new(RwLock::new(mgr)), panes)
    }

    #[cfg(unix)]
    async fn type_in(state: &AppState, pane: Uuid, input: &str) {
        let mut mgr = state.write().await;
        let pty = &mut mgr.find_pane_mut(pane).unwrap().pty;
        pty.ensure_spawned(80, 24).unwrap();
        pty.input_tx.send(input.as_bytes().to_vec()).unwrap();
    }

    #[cfg(unix)]
    async fn wait_until(
        state: &AppState,
        pane: Uuid,
        condition: impl Fn(&crate::pty::PtyHandle) -> bool,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !condition(&state.read().await.find_pane(pane).unwrap().pty) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn assert_kept(state: &AppState, panes: &[Uuid], path: &Path, message: &str) {
        let error = remove(state, panes[0]).await;
        assert!(
            matches!(&error, Err(Error::Conflict(m)) if m.contains(message)),
            "{:?}",
            error.err().map(|e| e.to_string())
        );
        assert!(path.exists());
        let mgr = state.read().await;
        assert!(panes.iter().all(|&pane| mgr.find_pane(pane).is_some()));
    }

    fn list(dir: &Path) -> Result<Vec<Info>, String> {
        list_in(&git2::Repository::discover(dir).unwrap(), dir)
    }

    #[test]
    fn parses_both_record_formats() {
        let z = "worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /a\nb\0detached\0locked why\0prunable gone\0\0";
        let records = parse_records(z, '\0');
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].branch.as_deref(), Some("main"));
        assert_eq!(records[1].path, "/a\nb");
        assert_eq!(records[1].locked.as_deref(), Some("why"));
        assert!(records[1].prunable && records[1].branch.is_none());

        // Without `-z`, a newline in a path can name another worktree.
        let lines = "worktree /a\nHEAD 1\n\nworktree /b\nworktree /a\nHEAD 2\n\n";
        let records = parse_records(lines, '\n');
        assert_eq!(records[1].path, "/a");
        assert!(unambiguous(records).is_err());
        assert!(unambiguous(parse_records("worktree /a\n\nworktree /b\n", '\n')).is_ok());
    }

    #[test]
    fn paths_follow_the_template() {
        let main = Path::new("/src/proj");
        assert_eq!(
            worktree_path(DEFAULT_PATH, main, "proj", "feat/x"),
            Path::new("/src/proj-feat-x")
        );
        assert_eq!(
            worktree_path("/wt/{repo}/{branch}", main, "proj", "x"),
            Path::new("/wt/proj/x")
        );
        assert_eq!(
            worktree_path(".worktrees/{branch}", main, "proj", "x"),
            Path::new("/src/.worktrees/x")
        );
    }

    #[test]
    fn adds_new_and_existing_branches_beside_the_main_worktree() {
        let repo = Repo::new();
        run(&repo.main, &["branch", "existing"]);
        let dir = repo.dir.canonicalize().unwrap();
        let (path, branch) = add(&repo.main, "feat/new", None, DEFAULT_PATH).unwrap();
        assert_eq!(path.canonicalize().unwrap(), dir.join("proj-feat-new"));
        assert_eq!(branch, "feat/new");
        // From a linked worktree, still beside the main one.
        let (path, _) = add(&path, "existing", None, DEFAULT_PATH).unwrap();
        assert_eq!(path.canonicalize().unwrap(), dir.join("proj-existing"));
        let head = git(&path, &[&"branch", &"--show-current"]).unwrap();
        assert_eq!(head, "existing");

        assert!(matches!(
            add(&repo.main, "existing", None, DEFAULT_PATH),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            add(&repo.main, "-x", None, DEFAULT_PATH),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            add(&repo.main, "a..b", None, DEFAULT_PATH),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn remote_branches_are_tracked() {
        let repo = Repo::new();
        run(&repo.main, &["branch", "remote-only"]);
        let clone = repo.dir.join("clone");
        run(&repo.dir, &["clone", "-q", "proj", "clone"]);
        let (path, _) = add(&clone, "remote-only", None, DEFAULT_PATH).unwrap();
        let upstream = git(&path, &[&"rev-parse", &"--abbrev-ref", &"@{upstream}"]).unwrap();
        assert_eq!(upstream, "origin/remote-only");
    }

    #[test]
    fn only_clean_linked_worktrees_are_removable() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", None, DEFAULT_PATH).unwrap();
        assert!(matches!(
            removable(&repo.main, false),
            Err(Error::Conflict(_))
        ));
        std::fs::create_dir(path.join("sub")).unwrap();
        std::fs::write(path.join("sub/new.txt"), "x").unwrap();
        run(&path, &["config", "status.showUntrackedFiles", "no"]);
        assert!(matches!(
            removable(&path.join("sub"), false),
            Err(Error::Conflict(_))
        ));
        std::fs::remove_file(path.join("sub/new.txt")).unwrap();
        let target = removable(&path.join("sub"), false).unwrap();
        assert_eq!(target.root, path);
        assert_eq!(target.branch.as_deref(), Some("feat"));
        #[cfg(unix)]
        {
            let alias = repo.dir.join("alias");
            std::os::unix::fs::symlink(path.join("sub"), &alias).unwrap();
            assert_eq!(removable(&alias, false).unwrap().root, path);
        }
        run(&repo.main, &["worktree", "lock", path.to_str().unwrap()]);
        assert!(matches!(removable(&path, false), Err(Error::Conflict(_))));
    }

    #[test]
    fn lists_worktrees_with_their_state() {
        let repo = Repo::new();
        let (feat, _) = add(&repo.main, "feat", None, DEFAULT_PATH).unwrap();
        let (gone, _) = add(&repo.main, "gone", None, DEFAULT_PATH).unwrap();
        run(
            &repo.main,
            &[
                "worktree",
                "lock",
                "--reason",
                "usb",
                "--",
                feat.to_str().unwrap(),
            ],
        );
        run(&feat, &["checkout", "-q", "--detach"]);
        std::fs::remove_dir_all(&gone).unwrap();

        let list = list(&feat.join(".")).unwrap();
        let paths: Vec<_> = list.iter().map(|w| PathBuf::from(&w.path)).collect();
        assert_eq!(paths, [repo.main.clone(), feat.clone(), gone.clone()]);
        assert!(list[0].main && !list[0].current && list[0].locked.is_none());
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].subject, "init");
        assert!(!list[1].main && list[1].current);
        assert_eq!(list[1].branch, None);
        assert_eq!(list[1].head.len(), 40);
        assert_eq!(list[1].locked.as_deref(), Some("usb"));
        assert!(list[2].prunable && !list[1].prunable);
    }

    #[tokio::test]
    async fn git_mode_ops_manage_worktrees_and_windows() {
        let repo = Repo::new();
        let (state, panes) = panes(&[&repo.main]).await;
        let session = state.read().await.session_of_pane(panes[0]);
        let windows = |state: AppState| async move { state.read().await.pane_infos().len() };
        let before = windows(state.clone()).await;

        let op = |json: serde_json::Value| serde_json::from_value::<Op>(json).unwrap();
        super::run(
            &state,
            session,
            &repo.main,
            op(serde_json::json!({"kind": "add", "branch": "a"})),
        )
        .await
        .unwrap();
        assert_eq!(windows(state.clone()).await, before);
        super::run(
            &state,
            session,
            &repo.main,
            op(serde_json::json!({"kind": "add", "branch": "b", "visit": true})),
        )
        .await
        .unwrap();
        assert_eq!(windows(state.clone()).await, before + 1);

        let a = repo.dir.join("proj-a");
        let a_str = a.to_str().unwrap();
        super::run(
            &state,
            session,
            &repo.main,
            op(serde_json::json!({"kind": "open", "path": a_str})),
        )
        .await
        .unwrap();
        assert_eq!(windows(state.clone()).await, before + 2);

        super::run(
            &state,
            session,
            &repo.main,
            op(serde_json::json!({"kind": "lock", "path": a_str})),
        )
        .await
        .unwrap();
        assert!(list(&repo.main).unwrap()[1].locked.is_some());
        super::run(
            &state,
            session,
            &repo.main,
            op(serde_json::json!({"kind": "unlock", "path": a_str})),
        )
        .await
        .unwrap();

        // Uncommitted changes need force.
        std::fs::write(a.join("new.txt"), "x").unwrap();
        let remove =
            |force| op(serde_json::json!({"kind": "remove", "path": a_str, "force": force}));
        assert!(super::run(&state, session, &repo.main, remove(false))
            .await
            .is_err());
        assert!(a.exists());
        let summary = super::run(&state, session, &repo.main, remove(true))
            .await
            .unwrap();
        assert!(summary.ends_with("closed its pane"), "{summary}");
        assert!(!a.exists());
        assert_eq!(windows(state.clone()).await, before + 1);

        std::fs::remove_dir_all(repo.dir.join("proj-b")).unwrap();
        let prune = || {
            super::run(
                &state,
                session,
                &repo.main,
                op(serde_json::json!({"kind": "prune"})),
            )
        };
        assert_eq!(prune().await.unwrap(), "Pruned 1 worktree");
        assert_eq!(list(&repo.main).unwrap().len(), 1);
        assert_eq!(prune().await.unwrap(), "Nothing to prune");

        // Not a worktree root, though inside one.
        let sub = repo.main.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub = sub.to_str().unwrap();
        for kind in ["open", "remove"] {
            let json = serde_json::json!({"kind": kind, "path": sub, "force": true});
            let error = super::run(&state, session, &repo.main, op(json)).await;
            assert!(matches!(error, Err(Error::Failed(_))), "{kind}");
        }
        assert!(repo.main.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn newline_paths_name_their_own_worktree() {
        let repo = Repo::new();
        let victim = repo.dir.join("victim");
        let newline = repo.dir.join("victim\nother");
        for (branch, path) in [("victim", &victim), ("newline", &newline)] {
            let path = path.to_str().unwrap();
            run(
                &repo.main,
                &["worktree", "add", "-q", "-b", branch, "--", path],
            );
        }
        std::fs::write(victim.join("keep.txt"), "x").unwrap();

        let list = list(&repo.main).unwrap();
        let entry = list.iter().find(|w| w.branch.as_deref() == Some("newline"));
        assert_eq!(entry.unwrap().path, newline.to_str().unwrap());
        let paths: Vec<_> = records(&repo.main)
            .unwrap()
            .into_iter()
            .map(|w| PathBuf::from(w.path))
            .collect();
        assert_eq!(paths, [repo.main.clone(), victim.clone(), newline.clone()]);

        let (state, panes) = panes(&[&repo.main]).await;
        let session = state.read().await.session_of_pane(panes[0]);
        let json =
            serde_json::json!({"kind": "remove", "path": entry.unwrap().path, "force": true});
        let op = serde_json::from_value::<Op>(json).unwrap();
        super::run(&state, session, &repo.main, op).await.unwrap();
        assert!(!newline.exists());
        assert!(victim.join("keep.txt").exists());
    }

    #[tokio::test]
    async fn ops_never_resolve_to_an_enclosing_worktree() {
        let repo = Repo::new();
        let (outer, _) = add(&repo.main, "outer", None, DEFAULT_PATH).unwrap();
        let nested = outer.join("nested");
        let nested_str = nested.to_str().unwrap();
        run(
            &repo.main,
            &["worktree", "add", "-q", "-b", "nested", "--", nested_str],
        );
        std::fs::remove_dir_all(&nested).unwrap();
        assert!(list(&repo.main).unwrap()[2].prunable);

        let (state, panes) = panes(&[&repo.main]).await;
        let session = state.read().await.session_of_pane(panes[0]);
        for kind in ["open", "remove"] {
            let json = serde_json::json!({"kind": kind, "path": nested_str, "force": true});
            let op = serde_json::from_value::<Op>(json).unwrap();
            let error = super::run(&state, session, &repo.main, op).await;
            assert!(matches!(error, Err(Error::Failed(_))), "{kind}");
        }
        assert!(outer.exists());
    }

    #[test]
    fn remote_branches_are_tracked_as_selected() {
        let repo = Repo::new();
        run(&repo.main, &["branch", "shared"]);
        let clone = repo.dir.join("clone");
        let up = repo.dir.join("up");
        run(&repo.dir, &["clone", "-q", "proj", "clone"]);
        run(&repo.dir, &["clone", "-q", "-b", "shared", "proj", "up"]);
        run(&up, &["commit", "-q", "--allow-empty", "-m", "up"]);
        run(&clone, &["remote", "add", "upstream", up.to_str().unwrap()]);
        run(&clone, &["fetch", "-q", "upstream"]);
        run(&clone, &["config", "checkout.defaultRemote", "origin"]);
        let rev = |dir: &Path, rev: &str| git(dir, &[&"rev-parse", &rev]).unwrap();

        // Not origin/shared, though it's the default remote.
        let (path, branch) = add(&clone, "shared", Some("upstream/shared"), DEFAULT_PATH).unwrap();
        assert_eq!(branch, "shared");
        assert_eq!(rev(&path, "@{upstream}"), rev(&clone, "upstream/shared"));
        assert_eq!(rev(&path, "HEAD"), rev(&clone, "upstream/shared"));

        // An existing local branch must already track it.
        run(&clone, &["branch", "--no-track", "mine", "origin/shared"]);
        assert!(matches!(
            add(&clone, "mine", Some("upstream/shared"), DEFAULT_PATH),
            Err(Error::Conflict(_))
        ));
        run(&clone, &["branch", "-u", "upstream/shared", "mine"]);
        let (path, _) = add(&clone, "mine", Some("upstream/shared"), DEFAULT_PATH).unwrap();
        assert_eq!(rev(&path, "HEAD"), rev(&clone, "origin/shared"));

        assert!(matches!(
            add(&clone, "x", Some("upstream/missing"), DEFAULT_PATH),
            Err(Error::Invalid(_))
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn programs_that_replaced_the_shell_keep_the_worktree() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", None, DEFAULT_PATH).unwrap();
        let (state, panes) = panes(&[&path]).await;
        type_in(&state, panes[0], "exec sleep 30\n").await;
        wait_until(&state, panes[0], |pty| pty.foreground_program().is_some()).await;
        assert_kept(&state, &panes, &path, "is running").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn panes_in_the_worktree_through_symlinks_keep_it() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", None, DEFAULT_PATH).unwrap();
        let alias = repo.dir.join("alias");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let (state, panes) = panes(&[&path, &alias]).await;
        let alias = alias.to_str().unwrap().to_string();
        let osc7 = format!("printf '\\033]7;file://localhost%s\\a' '{alias}'; sleep 30\n");
        type_in(&state, panes[1], &osc7).await;
        wait_until(&state, panes[1], |pty| {
            pty.local_cwd().as_deref() == Some(&alias) && pty.foreground_program().is_some()
        })
        .await;
        assert_kept(&state, &panes, &path, "is running").await;
    }

    #[tokio::test]
    async fn submodules_keep_the_worktree() {
        let repo = Repo::new();
        let lib = repo.dir.join("lib");
        std::fs::create_dir(&lib).unwrap();
        run(&lib, &["init", "-q"]);
        run(&lib, &["commit", "-q", "--allow-empty", "-m", "lib"]);
        let file = ["-c", "protocol.file.allow=always"];
        let lib = lib.to_str().unwrap();
        run(
            &repo.main,
            &[&file[..], &["submodule", "add", "-q", lib, "lib"]].concat(),
        );
        run(&repo.main, &["commit", "-q", "-m", "lib"]);
        let (path, _) = add(&repo.main, "feat", None, DEFAULT_PATH).unwrap();
        // git removes it while the submodule isn't checked out.
        assert!(removable(&path, false).is_ok());
        run(
            &path,
            &[&file[..], &["submodule", "update", "-q", "--init"]].concat(),
        );
        let (state, panes) = panes(&[&path]).await;
        assert_kept(&state, &panes, &path, "submodules").await;
        assert!(git(&path, &[&"worktree", &"remove", &"--", &path]).is_err());
    }
}
