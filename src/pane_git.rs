//! The git repo, worktree, and branch of pane working directories. Resolved
//! from the filesystem (no `git` subprocess) on a worker thread and cached per
//! directory, revalidated after `REVALIDATE`; each worktree's `HEAD` is watched
//! for branch switches. Changes signal `meta_tx`, which rebroadcasts state.
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// A pane's place in a git repo.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaneGit {
    /// The repo's common git dir, shared by all its worktrees.
    pub repo_id: String,
    pub repo_name: String,
    pub worktree_root: String,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The repo's main worktree rather than a linked one.
    pub main_worktree: bool,
}

/// When a cached directory is resolved again, for repo boundaries that
/// changed (`git init`, a removed `.git`).
const REVALIDATE: Duration = Duration::from_secs(10);
/// Cached directories before the cache is cleared.
const MAX_DIRS: usize = 4096;

enum Lookup {
    Pending,
    /// The worktree root containing the directory, if any.
    Resolved(Option<PathBuf>, Instant),
}

struct Worktree {
    git: PaneGit,
    /// Canonical, as watcher events report it.
    git_dir: PathBuf,
}

#[derive(Default)]
struct State {
    dirs: HashMap<String, Lookup>,
    worktrees: HashMap<PathBuf, Worktree>,
}

enum Job {
    Resolve(String),
    Changed(Vec<PathBuf>),
    Stop,
}

pub struct GitTracker {
    state: Arc<Mutex<State>>,
    jobs: mpsc::Sender<Job>,
}

impl GitTracker {
    pub fn new(changed: UnboundedSender<()>) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let (jobs, rx) = mpsc::channel();
        let worker = Worker {
            state: state.clone(),
            changed,
            jobs: jobs.clone(),
            watcher: None,
            watched: HashSet::new(),
        };
        if let Err(e) = std::thread::Builder::new()
            .name("pane-git".into())
            .spawn(move || worker.run(rx))
        {
            tracing::warn!("failed to start pane git tracker: {e}");
        }
        Self { state, jobs }
    }

    /// The cached identity of `cwd`. A miss queues resolution and returns
    /// `None`; a stale entry is returned while it's resolved again. `changed`
    /// fires when the result differs.
    pub fn lookup(&self, cwd: &str) -> Option<PaneGit> {
        let mut state = self.state.lock().unwrap();
        let State { dirs, worktrees } = &mut *state;
        match dirs.get_mut(cwd) {
            Some(Lookup::Pending) => return None,
            Some(Lookup::Resolved(root, at)) => {
                let git = root
                    .as_ref()
                    .and_then(|root| worktrees.get(root))
                    .map(|w| w.git.clone());
                if at.elapsed() >= REVALIDATE {
                    *at = Instant::now();
                    let _ = self.jobs.send(Job::Resolve(cwd.to_string()));
                }
                return git;
            }
            None => {}
        }
        if state.dirs.len() >= MAX_DIRS {
            state
                .dirs
                .retain(|_, lookup| matches!(lookup, Lookup::Pending));
        }
        state.dirs.insert(cwd.to_string(), Lookup::Pending);
        let _ = self.jobs.send(Job::Resolve(cwd.to_string()));
        None
    }
}

impl Drop for GitTracker {
    fn drop(&mut self) {
        let _ = self.jobs.send(Job::Stop);
    }
}

/// Owns the watcher: `notify` may deliver events on the thread that serves
/// `watch`, so only this thread calls it, never while holding `state`.
struct Worker {
    state: Arc<Mutex<State>>,
    changed: UnboundedSender<()>,
    jobs: mpsc::Sender<Job>,
    watcher: Option<notify::RecommendedWatcher>,
    watched: HashSet<PathBuf>,
}

impl Worker {
    fn run(mut self, rx: mpsc::Receiver<Job>) {
        while let Ok(job) = rx.recv() {
            match job {
                Job::Resolve(cwd) => self.resolve(cwd),
                Job::Changed(paths) => self.refresh(paths),
                Job::Stop => return,
            }
        }
    }

    fn resolve(&mut self, cwd: String) {
        let found = resolve(Path::new(&cwd));
        if let Some((_, worktree)) = &found {
            self.watch(worktree.git_dir.clone());
            // A watched directory's own removal may go unreported, and git
            // removes `<common>/worktrees` with its last entry.
            if !worktree.git.main_worktree {
                for dir in worktree.git_dir.ancestors().skip(1).take(2) {
                    self.watch(dir.to_path_buf());
                }
            }
        }
        let mut state = self.state.lock().unwrap();
        let State { dirs, worktrees } = &mut *state;
        let before = match dirs.get(&cwd) {
            Some(Lookup::Resolved(Some(root), _)) => worktrees.get(root).map(|w| w.git.clone()),
            _ => None,
        };
        let after = found.as_ref().map(|(_, worktree)| worktree.git.clone());
        let root = found.map(|(root, worktree)| {
            worktrees.insert(root.clone(), worktree);
            root
        });
        dirs.insert(cwd, Lookup::Resolved(root, Instant::now()));
        drop(state);
        if before != after {
            let _ = self.changed.send(());
        }
    }

    /// Reread the branch of worktrees whose `HEAD` changed; forget those
    /// whose git dir is gone (`git worktree remove`).
    fn refresh(&mut self, paths: Vec<PathBuf>) {
        let affects = |git_dir: &Path| {
            paths.iter().any(|path| {
                git_dir.starts_with(path)
                    || (path.file_name().is_some_and(|name| name == "HEAD")
                        && path.parent() == Some(git_dir))
            })
        };
        let mut gone = Vec::new();
        let mut changed = false;
        let mut state = self.state.lock().unwrap();
        let State { dirs, worktrees } = &mut *state;
        worktrees.retain(|_, worktree| {
            if !affects(&worktree.git_dir) {
                return true;
            }
            match read_head(&worktree.git_dir) {
                Some(branch) => {
                    changed |= worktree.git.branch != branch;
                    worktree.git.branch = branch;
                    true
                }
                None => {
                    gone.push(worktree.git_dir.clone());
                    changed = true;
                    false
                }
            }
        });
        dirs.retain(|_, lookup| match lookup {
            Lookup::Resolved(Some(root), _) => worktrees.contains_key(root),
            _ => true,
        });
        drop(state);
        // Watch them again if they're recreated.
        gone.extend(
            paths
                .iter()
                .filter(|path| self.watched.contains(*path) && !path.exists())
                .cloned(),
        );
        for dir in gone {
            self.unwatch(&dir);
        }
        if changed {
            let _ = self.changed.send(());
        }
    }

    fn watch(&mut self, dir: PathBuf) {
        if self.watched.contains(&dir) {
            return;
        }
        if self.watcher.is_none() {
            let jobs = self.jobs.clone();
            match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    let _ = jobs.send(Job::Changed(event.paths));
                }
            }) {
                Ok(watcher) => self.watcher = Some(watcher),
                Err(e) => {
                    tracing::warn!("failed to create git HEAD watcher: {e}");
                    return;
                }
            }
        }
        let watcher = self.watcher.as_mut().unwrap();
        match watcher.watch(&dir, RecursiveMode::NonRecursive) {
            Ok(()) => {
                self.watched.insert(dir);
            }
            Err(e) => tracing::debug!("failed to watch {}: {e}", dir.display()),
        }
    }

    fn unwatch(&mut self, dir: &Path) {
        if self.watched.remove(dir) {
            if let Some(watcher) = self.watcher.as_mut() {
                let _ = watcher.unwatch(dir);
            }
        }
    }
}

/// The identity and git dir of the worktree containing `dir`, uncached.
pub(crate) fn worktree_of(dir: &Path) -> Option<(PaneGit, PathBuf)> {
    resolve(dir).map(|(_, worktree)| (worktree.git, worktree.git_dir))
}

/// The worktree containing `dir`: its root and identity.
fn resolve(dir: &Path) -> Option<(PathBuf, Worktree)> {
    let dir = real_path(dir);
    let (root, dot_git) = dir.ancestors().find_map(|root| {
        let dot_git = root.join(".git");
        dot_git.exists().then(|| (root.to_path_buf(), dot_git))
    })?;
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // A linked worktree or submodule: `gitdir: <path>`.
        let contents = std::fs::read_to_string(&dot_git).ok()?;
        root.join(contents.strip_prefix("gitdir:")?.trim())
    };
    let branch = read_head(&git_dir)?;
    let common_dir = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(common) => Some(git_dir.join(common.trim())),
        Err(_) => None,
    };
    let main_worktree = common_dir.is_none();
    let common_dir = common_dir.unwrap_or_else(|| git_dir.clone());
    let common_dir = common_dir.canonicalize().unwrap_or(common_dir);
    let git = PaneGit {
        repo_id: common_dir.to_string_lossy().into_owned(),
        repo_name: repo_name(&common_dir),
        worktree_root: root.to_string_lossy().into_owned(),
        branch,
        main_worktree,
    };
    let git_dir = git_dir.canonicalize().unwrap_or(git_dir);
    Some((root, Worktree { git, git_dir }))
}

/// `dir` with symlinks resolved, as git finds its repo. Unchanged on Windows,
/// where a UNC path (WSL) would become a verbatim `\\?\UNC\` one.
fn real_path(dir: &Path) -> PathBuf {
    #[cfg(unix)]
    if let Ok(real) = dir.canonicalize() {
        return real;
    }
    dir.to_path_buf()
}

/// The branch `HEAD` names; `None` inside when detached, `None` outside when
/// unreadable.
fn read_head(git_dir: &Path) -> Option<Option<String>> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    Some(head.trim().strip_prefix("ref:").map(|r| {
        let r = r.trim();
        r.strip_prefix("refs/heads/").unwrap_or(r).to_string()
    }))
}

/// `repo/.git` → `repo`, `repo.git` → `repo`, `repo/.bare` → `repo`,
/// `super/.git/modules/sub` → `sub`.
pub(crate) fn repo_name(common_dir: &Path) -> String {
    let name = |path: &Path| {
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let own = name(common_dir);
    let own = own.strip_suffix(".git").unwrap_or(&own);
    if own.is_empty() || own.starts_with('.') {
        common_dir.parent().map(name).unwrap_or_default()
    } else {
        own.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-C"])
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    /// A temporary directory holding a repo at `proj` with one commit on `main`.
    struct Repo {
        dir: PathBuf,
        main: PathBuf,
    }

    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("btmux-pane-git-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("proj")).unwrap();
            let dir = real_path(&dir);
            let main = dir.join("proj");
            git(&main, &["init", "-q", "-b", "main"]);
            git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
            Self { dir, main }
        }

        /// A linked worktree at `proj-<branch>` on a new branch.
        fn worktree(&self, branch: &str) -> PathBuf {
            let path = self.dir.join(format!("proj-{branch}"));
            git(
                &self.main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    path.to_str().unwrap(),
                    "-b",
                    branch,
                ],
            );
            path
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn worktrees_share_a_repo_id() {
        let repo = Repo::new();
        let linked = repo.worktree("feat");
        std::fs::create_dir(repo.main.join("sub")).unwrap();

        let (root, a) = resolve(&repo.main.join("sub")).unwrap();
        assert_eq!(root, repo.main);
        let (_, b) = resolve(&linked).unwrap();
        assert_eq!(a.git.repo_id, b.git.repo_id);
        assert_eq!(a.git.repo_name, "proj");
        assert_eq!(b.git.repo_name, "proj");
        assert!(a.git.main_worktree);
        assert!(!b.git.main_worktree);
        assert_eq!(a.git.branch.as_deref(), Some("main"));
        assert_eq!(b.git.branch.as_deref(), Some("feat"));
        assert!(resolve(&repo.dir).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_resolve_like_git() {
        let repo = Repo::new();
        std::fs::create_dir(repo.main.join("sub")).unwrap();
        let alias = repo.dir.join("alias");
        std::os::unix::fs::symlink(repo.main.join("sub"), &alias).unwrap();
        let (root, _) = resolve(&alias).unwrap();
        assert_eq!(root, repo.main);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let repo = Repo::new();
        git(&repo.main, &["checkout", "-q", "--detach"]);
        let (_, w) = resolve(&repo.main).unwrap();
        assert_eq!(w.git.branch, None);
    }

    #[test]
    fn repo_names() {
        assert_eq!(repo_name(Path::new("/x/repo/.git")), "repo");
        assert_eq!(repo_name(Path::new("/x/repo.git")), "repo");
        assert_eq!(repo_name(Path::new("/x/repo/.bare")), "repo");
        assert_eq!(repo_name(Path::new("/x/s/.git/modules/sub")), "sub");
    }

    #[tokio::test]
    async fn lookups_follow_branch_switches_and_removal() {
        let repo = Repo::new();
        let linked = repo.worktree("feat");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let tracker = GitTracker::new(tx);
        let cwd = linked.to_str().unwrap();
        assert_eq!(tracker.lookup(cwd), None);
        changed(&mut rx).await;
        let found = tracker.lookup(cwd).unwrap();
        assert_eq!(found.branch.as_deref(), Some("feat"));

        git(&linked, &["switch", "-q", "-c", "other"]);
        loop {
            changed(&mut rx).await;
            if tracker.lookup(cwd).unwrap().branch.as_deref() == Some("other") {
                break;
            }
        }

        git(&repo.main, &["worktree", "remove", "--force", cwd]);
        loop {
            changed(&mut rx).await;
            let mut state = tracker.state.lock().unwrap();
            if state.worktrees.is_empty() {
                assert!(state.dirs.remove(cwd).is_none());
                break;
            }
        }
    }

    #[tokio::test]
    async fn lookups_follow_new_repos_inside_repos() {
        let repo = Repo::new();
        let sub = repo.main.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let tracker = GitTracker::new(tx);
        let cwd = sub.to_str().unwrap();
        assert_eq!(tracker.lookup(cwd), None);
        changed(&mut rx).await;
        assert_eq!(tracker.lookup(cwd).unwrap().branch.as_deref(), Some("main"));

        git(&sub, &["init", "-q", "-b", "inner"]);
        match tracker.state.lock().unwrap().dirs.get_mut(cwd) {
            Some(Lookup::Resolved(_, at)) => *at -= REVALIDATE,
            _ => panic!("not resolved"),
        }
        // Stale until resolved again.
        assert_eq!(tracker.lookup(cwd).unwrap().branch.as_deref(), Some("main"));
        changed(&mut rx).await;
        let found = tracker.lookup(cwd).unwrap();
        assert_eq!(found.branch.as_deref(), Some("inner"));
        assert_eq!(Path::new(&found.worktree_root), sub);
    }

    async fn changed(rx: &mut tokio::sync::mpsc::UnboundedReceiver<()>) {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("no change signal");
    }
}
