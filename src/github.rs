//! Pull request and CI status of the branches panes are on, from the `gh` CLI,
//! so btmux never reads a credential. Remotes and pushed commits are read from
//! the repo on disk; one GraphQL query per GitHub repo covers all its branches.
//! Polled only while a tab is connected, sooner while checks run or after a
//! push or fetch moves the branch's remote-tracking ref.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::AppState;

const TICK: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_secs(60);
/// While checks are pending, and for `AFTER_PUSH` after a push.
const POLL_FAST: Duration = Duration::from_secs(15);
const AFTER_PUSH: Duration = Duration::from_secs(120);
const AFTER_FAILURE: Duration = Duration::from_secs(300);
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// Pull requests per branch, newest first, before filtering out forks'.
const PULL_REQUESTS: usize = 5;
/// Check names listed per state.
const MAX_NAMES: usize = 20;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GithubStatus {
    pub repo_id: String,
    pub branch: String,
    /// The pull request's page, else the branch's.
    pub url: String,
    pub pr: Option<PullRequest>,
    /// Of the pull request's head, else of the pushed branch.
    pub checks: Option<Checks>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub state: PrState,
    pub review: Option<Review>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Review {
    Approved,
    ChangesRequested,
    Required,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Checks {
    pub state: CheckState,
    pub total: u32,
    pub failed: u32,
    pub pending: u32,
    /// Up to `MAX_NAMES` each.
    pub failed_names: Vec<String>,
    pub pending_names: Vec<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum CheckState {
    Success,
    Failure,
    Pending,
}

static STATUSES: LazyLock<Mutex<Vec<GithubStatus>>> = LazyLock::new(Mutex::default);

/// The latest statuses, for new control sockets.
pub fn statuses() -> Vec<GithubStatus> {
    STATUSES.lock().unwrap().clone()
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut poller = Poller::default();
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            poller.tick(&state).await;
        }
    });
}

/// A GitHub repository.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Repo {
    host: String,
    owner: String,
    name: String,
}

/// Where a local branch's pull requests and pushed commits are.
#[derive(Clone, Debug, PartialEq)]
struct Target {
    /// Where pull requests are opened: gh's default repo, else `upstream`,
    /// else where the branch is pushed.
    base: Repo,
    /// Where the branch is pushed.
    head: Repo,
    /// The branch's name there.
    head_ref: String,
    /// The pushed commit, from the remote-tracking ref.
    pushed: Option<String>,
}

type Key = (String, String);

struct Entry {
    target: Option<Target>,
    status: Option<GithubStatus>,
    next_poll: Instant,
    fast_until: Option<Instant>,
}

#[derive(Default)]
struct Poller {
    entries: HashMap<Key, Entry>,
    /// The last error per repo, logged once.
    errors: HashMap<Repo, String>,
    missing_gh_logged: bool,
}

impl Poller {
    async fn tick(&mut self, state: &AppState) {
        let (config, clients, branches, shell) = {
            let mgr = state.read().await;
            (
                mgr.github_config().clone(),
                mgr.client_count(),
                mgr.pane_branches(),
                mgr.shell().to_owned(),
            )
        };
        if !config.enabled {
            self.entries.clear();
            self.publish(state).await;
            return;
        }
        if clients == 0 {
            return;
        }
        let now = Instant::now();
        self.entries.retain(|key, _| branches.contains(key));
        for key in branches {
            self.entries.entry(key).or_insert(Entry {
                target: None,
                status: None,
                next_poll: now,
                fast_until: None,
            });
        }
        let keys: Vec<Key> = self.entries.keys().cloned().collect();
        let hosts = config.hosts;
        let targets = tokio::task::spawn_blocking(move || {
            keys.into_iter()
                .map(|key| {
                    let target = resolve(Path::new(&key.0), &key.1, &hosts);
                    (key, target)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (key, target) in targets {
            let Some(entry) = self.entries.get_mut(&key) else {
                continue;
            };
            if entry.target != target {
                let pushed = |t: &Option<Target>| t.as_ref().and_then(|t| t.pushed.clone());
                if entry.target.is_some() && pushed(&entry.target) != pushed(&target) {
                    entry.fast_until = Some(now + AFTER_PUSH);
                }
                if target.is_none() {
                    entry.status = None;
                }
                entry.target = target;
                entry.next_poll = now;
            }
        }

        let mut due: BTreeMap<Repo, Vec<Key>> = BTreeMap::new();
        for (key, entry) in &self.entries {
            if let Some(target) = &entry.target {
                due.entry(target.base.clone())
                    .or_default()
                    .push(key.clone());
            }
        }
        due.retain(|_, keys| keys.iter().any(|key| self.entries[key].next_poll <= now));
        if !due.is_empty() {
            match gh(&shell).await {
                Some(gh) => {
                    self.missing_gh_logged = false;
                    for (repo, keys) in due {
                        self.poll(&gh, repo, keys).await;
                    }
                }
                None if !self.missing_gh_logged => {
                    self.missing_gh_logged = true;
                    tracing::info!("github status: gh not found");
                }
                None => {}
            }
        }
        self.publish(state).await;
    }

    async fn poll(&mut self, gh: &Gh, repo: Repo, mut keys: Vec<Key>) {
        keys.sort();
        let branches: Vec<(&Key, &Target)> = keys
            .iter()
            .filter_map(|key| Some((key, self.entries[key].target.as_ref()?)))
            .collect();
        let query = build_query(&repo, branches.iter().map(|(_, target)| *target));
        let result = run_gh(gh, &repo.host, &query).await.and_then(|reply| {
            let repository = reply
                .pointer("/data/repository")
                .filter(|repo| !repo.is_null())
                .ok_or_else(|| graphql_error(&reply))?;
            Ok(branches
                .iter()
                .enumerate()
                .map(|(i, (key, target))| parse_branch(repository, i, key, target))
                .collect::<Vec<_>>())
        });
        let now = Instant::now();
        match result {
            Ok(statuses) => {
                if self.errors.remove(&repo).is_some() {
                    tracing::info!("github status: {}/{} recovered", repo.owner, repo.name);
                }
                for (key, status) in keys.iter().zip(statuses) {
                    let entry = self.entries.get_mut(key).unwrap();
                    let pending = status
                        .checks
                        .as_ref()
                        .is_some_and(|checks| checks.state == CheckState::Pending);
                    let fast = pending || entry.fast_until.is_some_and(|until| now < until);
                    entry.next_poll = now + if fast { POLL_FAST } else { POLL };
                    entry.status = Some(status);
                }
            }
            Err(error) => {
                if self.errors.get(&repo) != Some(&error) {
                    tracing::warn!("github status: {}/{}: {error}", repo.owner, repo.name);
                    self.errors.insert(repo, error);
                }
                for key in &keys {
                    self.entries.get_mut(key).unwrap().next_poll = now + AFTER_FAILURE;
                }
            }
        }
    }

    async fn publish(&self, state: &AppState) {
        let mut statuses: Vec<GithubStatus> = self
            .entries
            .values()
            .filter_map(|entry| entry.status.clone())
            .filter(|status| status.pr.is_some() || status.checks.is_some())
            .collect();
        statuses.sort_by(|a, b| (&a.repo_id, &a.branch).cmp(&(&b.repo_id, &b.branch)));
        {
            let mut published = STATUSES.lock().unwrap();
            if *published == statuses {
                return;
            }
            published.clone_from(&statuses);
        }
        let message = crate::ws::control::ServerMessage::Github { statuses };
        let json = serde_json::to_string(&message).unwrap();
        let _ = state.read().await.events().send(json);
    }
}

struct Gh {
    program: OsString,
    /// Replaces the server's `PATH`.
    path: Option<OsString>,
}

async fn gh(shell: &str) -> Option<Gh> {
    let [path] = crate::agent_limits::programs_paths(shell, [OsString::from("gh")]).await;
    let search = path.clone().or_else(|| std::env::var_os("PATH"))?;
    let program = crate::agent_limits::find_in("gh".as_ref(), &search)?;
    Some(Gh {
        program: program.into_os_string(),
        path,
    })
}

struct Query {
    text: String,
    variables: Vec<(String, String)>,
}

fn build_query<'a>(repo: &Repo, targets: impl Iterator<Item = &'a Target>) -> Query {
    let mut params = vec!["$owner: String!".to_string(), "$name: String!".to_string()];
    let mut fields = vec!["url".to_string()];
    let mut variables = vec![
        ("owner".to_string(), repo.owner.clone()),
        ("name".to_string(), repo.name.clone()),
    ];
    for (i, target) in targets.enumerate() {
        params.push(format!("$h{i}: String!"));
        variables.push((format!("h{i}"), target.head_ref.clone()));
        fields.push(format!(
            "b{i}: pullRequests(headRefName: $h{i}, first: {PULL_REQUESTS}, \
             orderBy: {{field: CREATED_AT, direction: DESC}}) {{ nodes {{ ...pr }} }}"
        ));
        // A fork's branch would need its own repository; its PR has checks.
        if target.head == target.base {
            params.push(format!("$r{i}: String!"));
            variables.push((format!("r{i}"), format!("refs/heads/{}", target.head_ref)));
            fields.push(format!(
                "c{i}: ref(qualifiedName: $r{i}) {{ target {{ ... on Commit {{ \
                 statusCheckRollup {{ ...rollup }} }} }} }}"
            ));
        }
    }
    let text = format!(
        "query({}) {{ repository(owner: $owner, name: $name) {{ {} }} }}\n\
         fragment pr on PullRequest {{ number title url state isDraft reviewDecision \
         headRepositoryOwner {{ login }} \
         commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ ...rollup }} }} }} }} }}\n\
         fragment rollup on StatusCheckRollup {{ state contexts(first: 100) {{ totalCount \
         checkRunCountsByState {{ state count }} statusContextCountsByState {{ state count }} \
         nodes {{ __typename ... on CheckRun {{ name status conclusion }} \
         ... on StatusContext {{ context state }} }} }} }}",
        params.join(", "),
        fields.join(" "),
    );
    Query { text, variables }
}

async fn run_gh(gh: &Gh, host: &str, query: &Query) -> Result<Value, String> {
    let mut command = Command::new(&gh.program);
    // Even for github.com, or gh would follow an inherited `GH_HOST`.
    command.args(["api", "graphql", "--hostname", host]);
    command.arg("-f").arg(format!("query={}", query.text));
    for (name, value) in &query.variables {
        command.arg("-f").arg(format!("{name}={value}"));
    }
    if let Some(path) = &gh.path {
        command.env("PATH", path);
    }
    command
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_SPINNER_DISABLED", "1")
        .env("NO_COLOR", "1")
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(QUERY_TIMEOUT, command.output())
        .await
        .map_err(|_| "gh timed out".to_string())?
        .map_err(|error| format!("gh: {error}"))?;
    // GraphQL errors exit nonzero with the reply on stdout.
    if let Ok(reply) = serde_json::from_slice::<Value>(&output.stdout) {
        return Ok(reply);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("no output");
    Err(format!("gh: {}", message.trim()))
}

fn graphql_error(reply: &Value) -> String {
    reply
        .pointer("/errors/0/message")
        .and_then(Value::as_str)
        .unwrap_or("no repository in the reply")
        .to_string()
}

fn parse_branch(repository: &Value, i: usize, key: &Key, target: &Target) -> GithubStatus {
    let repo_url = repository["url"].as_str().unwrap_or_default();
    let prs = repository[format!("b{i}")]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let ours: Vec<&Value> = prs
        .iter()
        .filter(|pr| {
            pr.pointer("/headRepositoryOwner/login")
                .and_then(Value::as_str)
                .is_none_or(|login| login.eq_ignore_ascii_case(&target.head.owner))
        })
        .collect();
    let pr = ours
        .iter()
        .find(|pr| pr["state"] == "OPEN")
        .or(ours.first())
        .copied();
    let (url, pr, checks) = match pr {
        Some(pr) => (
            pr["url"].as_str().unwrap_or(repo_url).to_string(),
            Some(parse_pr(pr)),
            pr.pointer("/commits/nodes/0/commit/statusCheckRollup")
                .and_then(parse_checks),
        ),
        None => (
            format!("{repo_url}/tree/{}", encode_path(&target.head_ref)),
            None,
            repository
                .pointer(&format!("/c{i}/target/statusCheckRollup"))
                .and_then(parse_checks),
        ),
    };
    GithubStatus {
        repo_id: key.0.clone(),
        branch: key.1.clone(),
        url,
        pr,
        checks,
    }
}

fn parse_pr(pr: &Value) -> PullRequest {
    let state = match pr["state"].as_str() {
        Some("MERGED") => PrState::Merged,
        Some("CLOSED") => PrState::Closed,
        _ if pr["isDraft"] == true => PrState::Draft,
        _ => PrState::Open,
    };
    let review = match pr["reviewDecision"].as_str() {
        Some("APPROVED") => Some(Review::Approved),
        Some("CHANGES_REQUESTED") => Some(Review::ChangesRequested),
        Some("REVIEW_REQUIRED") => Some(Review::Required),
        _ => None,
    };
    PullRequest {
        number: pr["number"].as_u64().unwrap_or_default() as u32,
        title: pr["title"].as_str().unwrap_or_default().to_string(),
        state,
        review,
    }
}

fn parse_checks(rollup: &Value) -> Option<Checks> {
    if rollup.is_null() {
        return None;
    }
    let state = match rollup["state"].as_str()? {
        "SUCCESS" => CheckState::Success,
        "PENDING" | "EXPECTED" => CheckState::Pending,
        _ => CheckState::Failure,
    };
    let contexts = &rollup["contexts"];
    let mut checks = Checks {
        state,
        total: contexts["totalCount"].as_u64().unwrap_or_default() as u32,
        failed: 0,
        pending: 0,
        failed_names: Vec::new(),
        pending_names: Vec::new(),
    };
    // Counts cover every context; names only the first page.
    let counts = [
        (
            "checkRunCountsByState",
            check_run_outcome as fn(&str) -> Option<CheckState>,
        ),
        ("statusContextCountsByState", status_outcome),
    ];
    for (field, outcome) in counts {
        for count in contexts[field].as_array().into_iter().flatten() {
            let n = count["count"].as_u64().unwrap_or_default() as u32;
            match outcome(count["state"].as_str().unwrap_or_default()) {
                Some(CheckState::Failure) => checks.failed += n,
                Some(CheckState::Pending) => checks.pending += n,
                _ => {}
            }
        }
    }
    for node in contexts["nodes"].as_array().into_iter().flatten() {
        let (name, outcome) = if node["__typename"] == "CheckRun" {
            let state = if node["status"] == "COMPLETED" {
                &node["conclusion"]
            } else {
                &node["status"]
            };
            (
                &node["name"],
                check_run_outcome(state.as_str().unwrap_or_default()),
            )
        } else {
            (
                &node["context"],
                status_outcome(node["state"].as_str().unwrap_or_default()),
            )
        };
        let names = match outcome {
            Some(CheckState::Failure) => &mut checks.failed_names,
            Some(CheckState::Pending) => &mut checks.pending_names,
            _ => continue,
        };
        if names.len() < MAX_NAMES {
            names.push(name.as_str().unwrap_or_default().to_string());
        }
    }
    Some(checks)
}

/// A check run's status or, once completed, its conclusion (`CheckRunState`).
fn check_run_outcome(state: &str) -> Option<CheckState> {
    match state {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" | "CANCELLED" | "STALE" | "COMPLETED" => None,
        "QUEUED" | "IN_PROGRESS" | "PENDING" | "WAITING" | "REQUESTED" => Some(CheckState::Pending),
        _ => Some(CheckState::Failure),
    }
}

/// A commit status's state (`StatusState`).
fn status_outcome(state: &str) -> Option<CheckState> {
    match state {
        "SUCCESS" => None,
        "PENDING" | "EXPECTED" => Some(CheckState::Pending),
        _ => Some(CheckState::Failure),
    }
}

/// A branch name as a URL path, keeping its slashes.
fn encode_path(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    for byte in branch.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The GitHub target of `branch` in the repo whose common git dir is `common_dir`.
fn resolve(common_dir: &Path, branch: &str, hosts: &[String]) -> Option<Target> {
    let config = GitConfig::parse(&std::fs::read_to_string(common_dir.join("config")).ok()?);
    let mut target = target(&config, branch, hosts)?;
    target.pushed = read_ref(
        common_dir,
        &format!(
            "refs/remotes/{}/{}",
            config.push_remote(branch)?,
            target.head_ref
        ),
    );
    Some(target)
}

fn target(config: &GitConfig, branch: &str, hosts: &[String]) -> Option<Target> {
    let push_remote = config.push_remote(branch)?;
    let url = |remote: &str| config.get("remote", Some(remote), "url");
    let push_url = config
        .get("remote", Some(&push_remote), "pushurl")
        .or_else(|| url(&push_remote))?;
    let head = parse_remote_url(push_url, hosts)?;
    // The push remote's fetch URL, which differs from a `pushurl` fork.
    let base = config
        .subsections("remote")
        .into_iter()
        .find(|remote| config.get("remote", Some(remote), "gh-resolved") == Some("base"))
        .or_else(|| url("upstream").map(|_| "upstream".to_string()))
        .unwrap_or_else(|| push_remote.clone());
    let base = url(&base)
        .and_then(|url| parse_remote_url(url, hosts))
        .filter(|base| base.host == head.host)
        .unwrap_or_else(|| head.clone());
    let tracks_push_remote = config.get("branch", Some(branch), "remote") == Some(&push_remote);
    let head_ref = config
        .get("branch", Some(branch), "merge")
        .filter(|_| tracks_push_remote)
        .and_then(|merge| merge.strip_prefix("refs/heads/"))
        .unwrap_or(branch)
        .to_string();
    Some(Target {
        base,
        head,
        head_ref,
        pushed: None,
    })
}

/// A ref's commit, loose or packed.
fn read_ref(common_dir: &Path, name: &str) -> Option<String> {
    if let Ok(oid) = std::fs::read_to_string(common_dir.join(name)) {
        return Some(oid.trim().to_string());
    }
    let packed = std::fs::read_to_string(common_dir.join("packed-refs")).ok()?;
    packed.lines().find_map(|line| {
        let (oid, r) = line.split_once(' ')?;
        (r == name).then(|| oid.to_string())
    })
}

/// `owner/name` on a GitHub host, from any URL form git accepts.
fn parse_remote_url(url: &str, hosts: &[String]) -> Option<Repo> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        (host, path)
    } else {
        // scp-like: [user@]host:path
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        (authority.rsplit('@').next()?, path)
    };
    let host = github_host(&host.to_ascii_lowercase(), hosts)?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(Repo {
        host,
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// github.com, from its SSH hosts and aliases like `github.com-work`, or a
/// configured GitHub Enterprise host. gh sends `GH_ENTERPRISE_TOKEN` to any
/// other host, so one named by a remote alone is never asked.
fn github_host(host: &str, hosts: &[String]) -> Option<String> {
    if host == "github.com" || host.starts_with("github.com-") || host.ends_with(".github.com") {
        return Some("github.com".into());
    }
    hosts
        .iter()
        .any(|trusted| trusted.eq_ignore_ascii_case(host))
        .then(|| host.to_string())
}

/// The few git config entries a target needs. Section and key names are
/// case-insensitive, subsections case-sensitive, as in git.
struct GitConfig {
    entries: Vec<(String, Option<String>, String, String)>,
}

impl GitConfig {
    fn parse(text: &str) -> Self {
        let mut entries = Vec::new();
        let mut section = (String::new(), None);
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
            if let Some(header) = line.strip_prefix('[') {
                let Some(header) = header.split(']').next() else {
                    continue;
                };
                section = match header.split_once(char::is_whitespace) {
                    Some((name, sub)) => {
                        let sub = sub.trim().trim_matches('"').replace("\\\"", "\"");
                        (name.to_ascii_lowercase(), Some(sub.replace("\\\\", "\\")))
                    }
                    // Deprecated `[section.sub]`, whose subsection is lowercased.
                    None => match header.split_once('.') {
                        Some((name, sub)) => {
                            (name.to_ascii_lowercase(), Some(sub.to_ascii_lowercase()))
                        }
                        None => (header.to_ascii_lowercase(), None),
                    },
                };
                continue;
            }
            let (key, value) = match line.split_once('=') {
                Some((key, value)) => (key.trim(), unquote(value.trim())),
                None => (line, "true".into()),
            };
            entries.push((
                section.0.clone(),
                section.1.clone(),
                key.to_ascii_lowercase(),
                value,
            ));
        }
        Self { entries }
    }

    /// The last value, as git reads it.
    fn get(&self, section: &str, sub: Option<&str>, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .rev()
            .find(|(s, b, k, _)| s == section && b.as_deref() == sub && k.eq_ignore_ascii_case(key))
            .map(|(_, _, _, value)| value.as_str())
    }

    fn subsections(&self, section: &str) -> Vec<String> {
        let mut seen = HashSet::new();
        self.entries
            .iter()
            .filter(|(s, ..)| s == section)
            .filter_map(|(_, sub, ..)| sub.clone())
            .filter(|sub| seen.insert(sub.clone()))
            .collect()
    }

    /// Where `git push` sends `branch`.
    fn push_remote(&self, branch: &str) -> Option<String> {
        let remote = [
            self.get("branch", Some(branch), "pushremote"),
            self.get("remote", None, "pushdefault"),
            self.get("branch", Some(branch), "remote"),
        ]
        .into_iter()
        .flatten()
        .find(|remote| *remote != ".")
        .unwrap_or("origin");
        self.get("remote", Some(remote), "url")
            .map(|_| remote.to_string())
    }
}

/// A value with its quotes removed, escapes resolved, and a trailing comment dropped.
fn unquote(value: &str) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(c) => out.push(c),
                None => {}
            },
            '#' | ';' if !quoted => break,
            c => out.push(c),
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo(owner: &str, name: &str) -> Repo {
        Repo {
            host: "github.com".into(),
            owner: owner.into(),
            name: name.into(),
        }
    }

    #[test]
    fn parses_remote_urls() {
        for url in [
            "https://github.com/o/r.git",
            "https://user@github.com/o/r",
            "https://github.com/o/r/",
            "git@github.com:o/r.git",
            "github.com:o/r",
            "ssh://git@github.com/o/r.git",
            "ssh://git@ssh.github.com:443/o/r.git",
            "git@github.com-work:o/r.git",
        ] {
            assert_eq!(parse_remote_url(url, &[]), Some(repo("o", "r")), "{url}");
        }
        // Enterprise hosts only when configured.
        let hosts = ["GitHub.Example.com".to_string()];
        assert_eq!(
            parse_remote_url("git@github.example.com:o/r.git", &hosts)
                .unwrap()
                .host,
            "github.example.com"
        );
        assert_eq!(
            parse_remote_url("git@github.example.com:o/r.git", &[]),
            None
        );
        assert_eq!(
            parse_remote_url("https://evilgithub.invalid/o/r", &hosts),
            None
        );
        for url in [
            "git@gitlab.com:o/r.git",
            "https://github.com/o",
            "/srv/git/r.git",
            "../r.git",
            "file:///github/o/r",
            "https://github.com/o/r/tree/main",
        ] {
            assert_eq!(parse_remote_url(url, &hosts), None, "{url}");
        }
    }

    #[test]
    fn parses_git_config() {
        let config = GitConfig::parse(
            r#"
[core]
	bare = false
[remote "origin"]
	url = git@github.com:me/r.git  # mine
	fetch = +refs/heads/*:refs/remotes/origin/*
[Branch "feat/x"]
	remote = origin
	merge = refs/heads/feature-x
[branch.Legacy]
	remote = origin
"#,
        );
        assert_eq!(
            config.get("remote", Some("origin"), "URL"),
            Some("git@github.com:me/r.git")
        );
        assert_eq!(
            config.get("branch", Some("feat/x"), "remote"),
            Some("origin")
        );
        assert_eq!(
            config.get("branch", Some("legacy"), "remote"),
            Some("origin")
        );
        assert_eq!(config.get("core", None, "bare"), Some("false"));
        assert_eq!(unquote(r#""a # b" ; c"#), "a # b");
    }

    #[test]
    fn targets_follow_push_and_base_remotes() {
        let config = GitConfig::parse(
            r#"
[remote "origin"]
	url = git@github.com:me/r.git
[remote "upstream"]
	url = https://github.com/them/r.git
[branch "feat"]
	remote = origin
	merge = refs/heads/feature
[branch "local"]
	remote = .
	merge = refs/heads/main
"#,
        );
        let feat = target(&config, "feat", &[]).unwrap();
        assert_eq!(feat.head, repo("me", "r"));
        assert_eq!(feat.base, repo("them", "r"));
        assert_eq!(feat.head_ref, "feature");
        // Tracking a local branch: pushed to origin under its own name.
        let local = target(&config, "local", &[]).unwrap();
        assert_eq!(local.head, repo("me", "r"));
        assert_eq!(local.head_ref, "local");

        // gh's default repo wins over `upstream`.
        let config = GitConfig::parse(
            r#"
[remote "origin"]
	url = git@github.com:me/r.git
	gh-resolved = base
[remote "upstream"]
	url = https://github.com/them/r.git
[remote "mirror"]
	url = git@gitlab.com:me/r.git
[branch "m"]
	pushRemote = mirror
"#,
        );
        assert_eq!(target(&config, "x", &[]).unwrap().base, repo("me", "r"));
        assert_eq!(target(&config, "m", &[]), None);
        assert_eq!(target(&GitConfig::parse(""), "x", &[]), None);

        // A `pushurl` fork: pushed there, PRs opened against the fetch URL.
        let config = GitConfig::parse(
            r#"
[remote "origin"]
	url = https://github.com/them/r.git
	pushurl = git@github.com:me/r.git
"#,
        );
        let fork = target(&config, "feat", &[]).unwrap();
        assert_eq!(fork.head, repo("me", "r"));
        assert_eq!(fork.base, repo("them", "r"));
    }

    #[test]
    fn reads_loose_and_packed_refs() {
        let dir = std::env::temp_dir().join(format!("btmux-github-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("refs/remotes/origin")).unwrap();
        std::fs::write(dir.join("refs/remotes/origin/a"), "aaa\n").unwrap();
        std::fs::write(
            dir.join("packed-refs"),
            "# pack-refs with: peeled\nbbb refs/remotes/origin/b/c\n",
        )
        .unwrap();
        assert_eq!(
            read_ref(&dir, "refs/remotes/origin/a").as_deref(),
            Some("aaa")
        );
        assert_eq!(
            read_ref(&dir, "refs/remotes/origin/b/c").as_deref(),
            Some("bbb")
        );
        assert_eq!(read_ref(&dir, "refs/remotes/origin/d"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queries_take_branches_as_variables() {
        let feat = Target {
            base: repo("o", "r"),
            head: repo("o", "r"),
            head_ref: "feat\"x".into(),
            pushed: None,
        };
        let fork = Target {
            head: repo("me", "r"),
            head_ref: "fix".into(),
            ..feat.clone()
        };
        let query = build_query(&repo("o", "r"), [&feat, &fork].into_iter());
        assert!(!query.text.contains("feat"));
        assert!(query.text.contains("c0: ref(qualifiedName: $r0)"));
        assert!(!query.text.contains("$r1"));
        assert!(query.text.contains("b1: pullRequests(headRefName: $h1"));
        assert_eq!(
            query.variables,
            [
                ("owner".to_string(), "o".to_string()),
                ("name".to_string(), "r".to_string()),
                ("h0".to_string(), "feat\"x".to_string()),
                ("r0".to_string(), "refs/heads/feat\"x".to_string()),
                ("h1".to_string(), "fix".to_string()),
            ]
        );
    }

    fn check_run(name: &str, status: &str, conclusion: Option<&str>) -> Value {
        json!({"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion})
    }

    #[test]
    fn picks_the_open_pull_request_of_the_head_owner() {
        let target = Target {
            base: repo("them", "r"),
            head: repo("me", "r"),
            head_ref: "feat".into(),
            pushed: None,
        };
        let pr = |number: u32, owner: &str, state: &str| {
            json!({
                "number": number, "title": format!("PR {number}"),
                "url": format!("https://github.com/them/r/pull/{number}"),
                "state": state, "isDraft": false, "reviewDecision": "APPROVED",
                "headRepositoryOwner": {"login": owner},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": {
                    "state": "FAILURE",
                    "contexts": {"totalCount": 4,
                        "checkRunCountsByState": [
                            {"state": "SUCCESS", "count": 1},
                            {"state": "FAILURE", "count": 1},
                            {"state": "IN_PROGRESS", "count": 1},
                        ],
                        "statusContextCountsByState": [{"state": "ERROR", "count": 1}],
                        "nodes": [
                        check_run("build", "COMPLETED", Some("SUCCESS")),
                        check_run("lint", "COMPLETED", Some("FAILURE")),
                        check_run("e2e", "IN_PROGRESS", None),
                        {"__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR"},
                    ]},
                }}}]},
            })
        };
        let repository = json!({
            "url": "https://github.com/them/r",
            "b0": {"nodes": [pr(3, "someone", "OPEN"), pr(2, "Me", "MERGED"), pr(1, "me", "OPEN")]},
        });
        let key = ("/repo/.git".to_string(), "feat".to_string());
        let status = parse_branch(&repository, 0, &key, &target);
        assert_eq!(status.url, "https://github.com/them/r/pull/1");
        assert_eq!(
            status.pr,
            Some(PullRequest {
                number: 1,
                title: "PR 1".into(),
                state: PrState::Open,
                review: Some(Review::Approved),
            })
        );
        assert_eq!(
            status.checks,
            Some(Checks {
                state: CheckState::Failure,
                total: 4,
                failed: 2,
                pending: 1,
                failed_names: vec!["lint".into(), "ci/legacy".into()],
                pending_names: vec!["e2e".into()],
            })
        );
    }

    #[test]
    fn branches_without_a_pull_request_show_their_checks() {
        let target = Target {
            base: repo("o", "r"),
            head: repo("o", "r"),
            head_ref: "release/1.0#x".into(),
            pushed: None,
        };
        let repository = json!({
            "url": "https://github.com/o/r",
            "b0": {"nodes": []},
            "c0": {"target": {"statusCheckRollup": {
                "state": "PENDING", "contexts": {"totalCount": 1,
                    "checkRunCountsByState": [{"state": "QUEUED", "count": 1}],
                    "nodes": [check_run("ci", "QUEUED", None)]},
            }}},
        });
        let key = ("/r/.git".to_string(), "x".to_string());
        let status = parse_branch(&repository, 0, &key, &target);
        assert_eq!(status.url, "https://github.com/o/r/tree/release/1.0%23x");
        assert_eq!(status.pr, None);
        assert_eq!(status.checks.unwrap().state, CheckState::Pending);

        let repository = json!({"url": "https://github.com/o/r", "b0": {"nodes": []}, "c0": null});
        let status = parse_branch(&repository, 0, &key, &target);
        assert_eq!((status.pr, status.checks), (None, None));
    }

    #[test]
    fn counts_checks_beyond_the_first_page() {
        let nodes: Vec<Value> = (0..100)
            .map(|i| check_run(&format!("ok{i}"), "COMPLETED", Some("SUCCESS")))
            .collect();
        let checks = parse_checks(&json!({
            "state": "FAILURE",
            "contexts": {
                "totalCount": 103,
                "checkRunCountsByState": [
                    {"state": "SUCCESS", "count": 100},
                    {"state": "TIMED_OUT", "count": 1},
                    {"state": "WAITING", "count": 1},
                ],
                "statusContextCountsByState": [{"state": "FAILURE", "count": 1}],
                "nodes": nodes,
            },
        }))
        .unwrap();
        assert_eq!((checks.total, checks.failed, checks.pending), (103, 2, 1));
        assert!(checks.failed_names.is_empty() && checks.pending_names.is_empty());
    }

    #[test]
    fn draft_and_closed_states() {
        let pr = |state: &str, draft: bool| {
            parse_pr(&json!({"number": 1, "title": "t", "state": state, "isDraft": draft, "reviewDecision": null}))
                .state
        };
        assert_eq!(pr("OPEN", true), PrState::Draft);
        assert_eq!(pr("OPEN", false), PrState::Open);
        assert_eq!(pr("MERGED", false), PrState::Merged);
        assert_eq!(pr("CLOSED", true), PrState::Closed);
    }
}
