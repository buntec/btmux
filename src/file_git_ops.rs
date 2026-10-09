//! Magit-style branch, fetch, pull, push, and stash operations for git mode.
//! Mutations shell out to `git` so credential helpers, hooks, and SSH config apply.

use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitStashInfo {
    pub index: usize,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct GitRefsResult {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub local_branches: Vec<GitBranchInfo>,
    pub remote_branches: Vec<String>,
    pub remotes: Vec<String>,
    pub stashes: Vec<GitStashInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitOp {
    Checkout {
        target: String,
    },
    CreateBranch {
        name: String,
        #[serde(default)]
        checkout: bool,
    },
    RenameBranch {
        from: String,
        to: String,
    },
    DeleteBranch {
        name: String,
    },
    Fetch {
        remote: Option<String>,
        #[serde(default)]
        all: bool,
        #[serde(default)]
        prune: bool,
        #[serde(default)]
        tags: bool,
    },
    Pull {
        remote: Option<String>,
        branch: Option<String>,
        #[serde(default)]
        rebase: bool,
        #[serde(default)]
        ff_only: bool,
    },
    Push {
        remote: Option<String>,
        refspec: Option<String>,
        #[serde(default)]
        set_upstream: bool,
        #[serde(default)]
        force_with_lease: bool,
        #[serde(default)]
        no_verify: bool,
        #[serde(default)]
        dry_run: bool,
        #[serde(default)]
        tags: bool,
    },
    StashPush {
        message: Option<String>,
        #[serde(default)]
        staged: bool,
        #[serde(default)]
        include_untracked: bool,
        #[serde(default)]
        all: bool,
    },
    StashApply {
        index: usize,
        #[serde(default)]
        pop: bool,
    },
    StashDrop {
        index: usize,
    },
    /// Stages all changes to tracked files, like magit's `S`.
    StageAll,
    UnstageAll,
}

pub async fn git_refs(root: &Path) -> Result<GitRefsResult, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || git_refs_sync(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// Runs `op` with the git CLI and returns its combined output.
pub async fn git_run(root: &Path, op: GitOp) -> Result<String, String> {
    let root = root.to_path_buf();
    let (workdir, args) = {
        let root = root.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let repo = open_repo(&root)?;
            let workdir = repo
                .workdir()
                .ok_or("Bare repositories are not supported")?
                .to_path_buf();
            Ok((workdir, op_args(&repo, op)?))
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let child = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(&workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    let output = tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("git {} timed out", args[0]))?
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let text = [output.stdout, output.stderr]
        .iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if output.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err(format!("git {} failed ({})", args[0], output.status))
    } else {
        Err(text)
    }
}

fn open_repo(root: &Path) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("Not a git repository: {}", e))
}

/// Rejects empty values and values git would parse as options.
fn arg(value: &str, what: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{} cannot be empty", what));
    }
    if value.starts_with('-') {
        return Err(format!("Invalid {}: {}", what.to_lowercase(), value));
    }
    Ok(value.to_string())
}

fn op_args(repo: &Repository, op: GitOp) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let mut push = |values: &[&str]| args.extend(values.iter().map(|v| v.to_string()));
    match op {
        GitOp::Checkout { target } => {
            let target = arg(&target, "Branch")?;
            if repo.find_branch(&target, BranchType::Local).is_ok() {
                push(&["switch", &target]);
            } else if repo.find_branch(&target, BranchType::Remote).is_ok() {
                // Check out the local branch for a remote one, creating it if needed.
                let local = target
                    .split_once('/')
                    .map(|(_, name)| name)
                    .unwrap_or(&target);
                if repo.find_branch(local, BranchType::Local).is_ok() {
                    push(&["switch", local]);
                } else {
                    push(&["switch", "--track", &target]);
                }
            } else {
                push(&["switch", "--detach", &target]);
            }
        }
        GitOp::CreateBranch { name, checkout } => {
            let name = arg(&name, "Branch name")?;
            if checkout {
                push(&["switch", "-c", &name]);
            } else {
                push(&["branch", &name]);
            }
        }
        GitOp::RenameBranch { from, to } => {
            push(&[
                "branch",
                "-m",
                &arg(&from, "Branch")?,
                &arg(&to, "Branch name")?,
            ]);
        }
        GitOp::DeleteBranch { name } => {
            push(&["branch", "-d", &arg(&name, "Branch")?]);
        }
        GitOp::Fetch {
            remote,
            all,
            prune,
            tags,
        } => {
            push(&["fetch"]);
            if prune {
                push(&["--prune"]);
            }
            if tags {
                push(&["--tags"]);
            }
            if all {
                push(&["--all"]);
            } else if let Some(remote) = remote {
                push(&[&arg(&remote, "Remote")?]);
            }
        }
        GitOp::Pull {
            remote,
            branch,
            rebase,
            ff_only,
        } => {
            push(&["pull"]);
            if rebase {
                push(&["--rebase"]);
            }
            if ff_only {
                push(&["--ff-only"]);
            }
            if let Some(remote) = remote {
                push(&[&arg(&remote, "Remote")?]);
                if let Some(branch) = branch {
                    push(&[&arg(&branch, "Branch")?]);
                }
            }
        }
        GitOp::Push {
            remote,
            refspec,
            set_upstream,
            force_with_lease,
            no_verify,
            dry_run,
            tags,
        } => {
            push(&["push"]);
            if set_upstream {
                push(&["--set-upstream"]);
            }
            if force_with_lease {
                push(&["--force-with-lease"]);
            }
            if no_verify {
                push(&["--no-verify"]);
            }
            if dry_run {
                push(&["--dry-run"]);
            }
            if tags {
                push(&["--tags"]);
            }
            if let Some(remote) = remote {
                push(&[&arg(&remote, "Remote")?]);
                if let Some(refspec) = refspec {
                    push(&[&arg(&refspec, "Branch")?]);
                }
            }
        }
        GitOp::StashPush {
            message,
            staged,
            include_untracked,
            all,
        } => {
            push(&["stash", "push"]);
            if staged {
                push(&["--staged"]);
            }
            if all {
                push(&["--all"]);
            } else if include_untracked {
                push(&["--include-untracked"]);
            }
            if let Some(message) = message.filter(|m| !m.trim().is_empty()) {
                push(&["-m", message.trim()]);
            }
        }
        GitOp::StashApply { index, pop } => {
            let stash = format!("stash@{{{}}}", index);
            push(&["stash", if pop { "pop" } else { "apply" }, &stash]);
        }
        GitOp::StashDrop { index } => {
            push(&["stash", "drop", &format!("stash@{{{}}}", index)]);
        }
        GitOp::StageAll => push(&["add", "-u"]),
        GitOp::UnstageAll => push(&["reset", "-q"]),
    }
    Ok(args)
}

fn git_refs_sync(root: &Path) -> Result<GitRefsResult, String> {
    let mut repo = open_repo(root)?;
    let branch = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string));

    let mut local_branches = Vec::new();
    for entry in repo
        .branches(Some(BranchType::Local))
        .map_err(|e| format!("Failed to list branches: {}", e))?
    {
        let Ok((local, _)) = entry else { continue };
        let Ok(Some(name)) = local.name() else {
            continue;
        };
        let upstream = local
            .upstream()
            .ok()
            .and_then(|upstream| upstream.name().ok().flatten().map(str::to_string));
        local_branches.push(GitBranchInfo {
            name: name.to_string(),
            is_head: local.is_head(),
            upstream,
        });
    }
    local_branches.sort_by(|a, b| a.name.cmp(&b.name));
    let upstream = local_branches
        .iter()
        .find(|b| b.is_head)
        .and_then(|b| b.upstream.clone());

    let mut remote_branches = Vec::new();
    for entry in repo
        .branches(Some(BranchType::Remote))
        .map_err(|e| format!("Failed to list remote branches: {}", e))?
    {
        let Ok((remote, _)) = entry else { continue };
        // Skip symbolic refs like `origin/HEAD`.
        if remote.get().symbolic_target().is_some() {
            continue;
        }
        if let Ok(Some(name)) = remote.name() {
            remote_branches.push(name.to_string());
        }
    }
    remote_branches.sort();

    let remotes = repo
        .remotes()
        .map_err(|e| format!("Failed to list remotes: {}", e))?
        .iter()
        .flatten()
        .map(str::to_string)
        .collect();

    let mut stashes = Vec::new();
    // Listing stashes can fail in repos without any; treat that as empty.
    let _ = repo.stash_foreach(|index, message, _| {
        stashes.push(GitStashInfo {
            index,
            message: message.to_string(),
        });
        true
    });

    Ok(GitRefsResult {
        branch,
        upstream,
        local_branches,
        remote_branches,
        remotes,
        stashes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::fs;

    fn init_repo(prefix: &str) -> (std::path::PathBuf, Repository) {
        let root = std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("file.txt"), "one\n").unwrap();
        let repo = Repository::init(&root).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let signature = Signature::now("btmux", "btmux@example.com").unwrap();
            repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
                .unwrap();
        }
        (root, repo)
    }

    #[test]
    fn op_args_reject_option_like_values() {
        let (root, repo) = init_repo("btmux-git-ops-args");
        let op = GitOp::DeleteBranch {
            name: "--force".into(),
        };
        assert!(op_args(&repo, op).is_err());
        let op = GitOp::Fetch {
            remote: Some("-oProxyCommand=x".into()),
            all: false,
            prune: true,
            tags: false,
        };
        assert!(op_args(&repo, op).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn op_args_build_expected_commands() {
        let (root, repo) = init_repo("btmux-git-ops-build");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();

        let args = op_args(
            &repo,
            GitOp::Checkout {
                target: "feature".into(),
            },
        )
        .unwrap();
        assert_eq!(args, ["switch", "feature"]);

        let args = op_args(
            &repo,
            GitOp::Checkout {
                target: head.id().to_string(),
            },
        )
        .unwrap();
        assert_eq!(args[..2], ["switch", "--detach"]);

        let args = op_args(
            &repo,
            GitOp::Push {
                remote: Some("origin".into()),
                refspec: Some("main".into()),
                set_upstream: true,
                force_with_lease: true,
                no_verify: false,
                dry_run: false,
                tags: false,
            },
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "push",
                "--set-upstream",
                "--force-with-lease",
                "origin",
                "main"
            ]
        );

        let args = op_args(
            &repo,
            GitOp::StashPush {
                message: Some(" wip ".into()),
                staged: false,
                include_untracked: true,
                all: false,
            },
        )
        .unwrap();
        assert_eq!(args, ["stash", "push", "--include-untracked", "-m", "wip"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn branch_and_stash_round_trip() {
        let (root, repo) = init_repo("btmux-git-ops-run");
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "btmux").unwrap();
        config.set_str("user.email", "btmux@example.com").unwrap();

        git_run(
            &root,
            GitOp::CreateBranch {
                name: "topic".into(),
                checkout: true,
            },
        )
        .await
        .unwrap();
        let refs = git_refs(&root).await.unwrap();
        assert_eq!(refs.branch.as_deref(), Some("topic"));
        assert_eq!(refs.local_branches.len(), 2);

        fs::write(root.join("file.txt"), "two\n").unwrap();
        git_run(
            &root,
            GitOp::StashPush {
                message: Some("saved".into()),
                staged: false,
                include_untracked: false,
                all: false,
            },
        )
        .await
        .unwrap();
        let refs = git_refs(&root).await.unwrap();
        assert_eq!(refs.stashes.len(), 1);
        assert!(refs.stashes[0].message.contains("saved"));
        assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "one\n");

        git_run(
            &root,
            GitOp::StashApply {
                index: 0,
                pop: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "two\n");
        assert!(git_refs(&root).await.unwrap().stashes.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stage_all_skips_untracked_and_unstage_all_clears_index() {
        let (root, _repo) = init_repo("btmux-git-ops-stage-all");
        fs::write(root.join("file.txt"), "two\n").unwrap();
        fs::write(root.join("new.txt"), "new\n").unwrap();

        git_run(&root, GitOp::StageAll).await.unwrap();
        let status = crate::file_git::git_status(&root, false).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert!(status.unstaged.is_empty());
        assert_eq!(status.untracked, ["new.txt"]);

        git_run(&root, GitOp::UnstageAll).await.unwrap();
        let status = crate::file_git::git_status(&root, false).await.unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 1);

        fs::remove_dir_all(root).unwrap();
    }
}
