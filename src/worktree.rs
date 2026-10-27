//! Git worktree creation and removal for panes, shared by the control socket,
//! REST, MCP, and the CLI. Runs the `git` CLI so hooks and config apply.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
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

/// Create a worktree for `branch` in the repo of `pane_id`'s directory and
/// open a window there, in the pane's session. An existing local or remote
/// branch is checked out; otherwise it's created from the pane's HEAD.
pub async fn create(
    state: &AppState,
    pane_id: Uuid,
    branch: &str,
    select: bool,
) -> Result<Created, Error> {
    let branch = branch.trim().to_string();
    let (session_id, cwd, template) = {
        let mgr = state.read().await;
        let session_id = mgr
            .session_of_pane(pane_id)
            .ok_or(Error::PaneNotFound(pane_id))?;
        let cwd = mgr.find_pane(pane_id).and_then(|p| p.pty.local_cwd());
        (session_id, cwd, mgr.worktree_path_template())
    };
    let cwd = cwd.ok_or_else(|| Error::Conflict("The pane has no local directory".into()))?;
    let (path, branch) =
        tokio::task::spawn_blocking(move || add(Path::new(&cwd), &branch, &template))
            .await
            .map_err(|e| Error::Failed(e.to_string()))??;
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
    let target = tokio::task::spawn_blocking(move || removable(Path::new(&cwd)))
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
    tokio::task::spawn_blocking(move || git(&root, &[&"worktree", &"remove", &"--", &root]))
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
fn add(dir: &Path, branch: &str, template: &str) -> Result<(PathBuf, String), Error> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(Error::Invalid(format!("Invalid branch name: {branch:?}")));
    }
    let branch = git(dir, &[&"check-ref-format", &"--branch", &branch])
        .map_err(|_| Error::Invalid(format!("Invalid branch name: {branch:?}")))?;
    let common = git(
        dir,
        &[&"rev-parse", &"--path-format=absolute", &"--git-common-dir"],
    )?;
    let list = git(dir, &[&"worktree", &"list", &"--porcelain"])?;
    let main = list
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .ok_or("git listed no worktrees")?;
    let repo = crate::pane_git::repo_name(Path::new(&common));
    let path = worktree_path(template, Path::new(main), &repo, &branch);
    if path.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            path.display()
        )));
    }

    let local_ref = format!("refs/heads/{branch}");
    let local = git(dir, &[&"show-ref", &"--verify", &"--quiet", &local_ref]).is_ok();
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
    branch: Option<String>,
}

/// The linked worktree containing `dir`, if git would remove it.
fn removable(dir: &Path) -> Result<Target, Error> {
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
            // Worktree roots are canonical on Unix.
            #[cfg(unix)]
            let dir = dir.canonicalize().unwrap();
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
        let (path, branch) = add(&repo.main, "feat/new", DEFAULT_PATH).unwrap();
        assert_eq!(path.canonicalize().unwrap(), dir.join("proj-feat-new"));
        assert_eq!(branch, "feat/new");
        // From a linked worktree, still beside the main one.
        let (path, _) = add(&path, "existing", DEFAULT_PATH).unwrap();
        assert_eq!(path.canonicalize().unwrap(), dir.join("proj-existing"));
        let head = git(&path, &[&"branch", &"--show-current"]).unwrap();
        assert_eq!(head, "existing");

        assert!(matches!(
            add(&repo.main, "existing", DEFAULT_PATH),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            add(&repo.main, "-x", DEFAULT_PATH),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            add(&repo.main, "a..b", DEFAULT_PATH),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn remote_branches_are_tracked() {
        let repo = Repo::new();
        run(&repo.main, &["branch", "remote-only"]);
        let clone = repo.dir.join("clone");
        run(&repo.dir, &["clone", "-q", "proj", "clone"]);
        let (path, _) = add(&clone, "remote-only", DEFAULT_PATH).unwrap();
        let upstream = git(&path, &[&"rev-parse", &"--abbrev-ref", &"@{upstream}"]).unwrap();
        assert_eq!(upstream, "origin/remote-only");
    }

    #[test]
    fn only_clean_linked_worktrees_are_removable() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", DEFAULT_PATH).unwrap();
        assert!(matches!(removable(&repo.main), Err(Error::Conflict(_))));
        std::fs::create_dir(path.join("sub")).unwrap();
        std::fs::write(path.join("sub/new.txt"), "x").unwrap();
        run(&path, &["config", "status.showUntrackedFiles", "no"]);
        assert!(matches!(
            removable(&path.join("sub")),
            Err(Error::Conflict(_))
        ));
        std::fs::remove_file(path.join("sub/new.txt")).unwrap();
        let target = removable(&path.join("sub")).unwrap();
        assert_eq!(target.root, path);
        assert_eq!(target.branch.as_deref(), Some("feat"));
        #[cfg(unix)]
        {
            let alias = repo.dir.join("alias");
            std::os::unix::fs::symlink(path.join("sub"), &alias).unwrap();
            assert_eq!(removable(&alias).unwrap().root, path);
        }
        run(&repo.main, &["worktree", "lock", path.to_str().unwrap()]);
        assert!(matches!(removable(&path), Err(Error::Conflict(_))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn programs_that_replaced_the_shell_keep_the_worktree() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", DEFAULT_PATH).unwrap();
        let (state, panes) = panes(&[&path]).await;
        type_in(&state, panes[0], "exec sleep 30\n").await;
        wait_until(&state, panes[0], |pty| pty.foreground_program().is_some()).await;
        assert_kept(&state, &panes, &path, "is running").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn panes_in_the_worktree_through_symlinks_keep_it() {
        let repo = Repo::new();
        let (path, _) = add(&repo.main, "feat", DEFAULT_PATH).unwrap();
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
        let (path, _) = add(&repo.main, "feat", DEFAULT_PATH).unwrap();
        // git removes it while the submodule isn't checked out.
        assert!(removable(&path).is_ok());
        run(
            &path,
            &[&file[..], &["submodule", "update", "-q", "--init"]].concat(),
        );
        let (state, panes) = panes(&[&path]).await;
        assert_kept(&state, &panes, &path, "submodules").await;
        assert!(git(&path, &[&"worktree", &"remove", &"--", &path]).is_err());
    }
}
