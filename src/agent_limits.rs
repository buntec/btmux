//! Subscription limits, read from the agent CLIs without sending a prompt.
//!
//! Each read starts the CLI, so it does its own auth and btmux never touches a
//! credential. `GET /api/agent-limits` reads at most once per `CACHE_FOR`, and
//! only tabs showing the limits ask.

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent_launch::{self, Agent};
use crate::AppState;

const CACHE_FOR: Duration = Duration::from_secs(50);
/// A failed read keeps the last limits this long, so a network blip doesn't hide them.
const KEEP_AFTER_FAILURE: Duration = Duration::from_secs(600);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(10);
/// How often to ask the pane shell again while a CLI is on no known `PATH`.
const SHELL_PATH_RETRY: Duration = Duration::from_secs(600);
/// Shell startup can print anything, even on the line of an unterminated escape.
#[cfg(unix)]
const SHELL_PATH_MARKER: &str = "__btmux_path__";
/// Codex doesn't grade its windows; Claude's come graded.
const CODEX_WARNING_PERCENT: f64 = 80.0;
const CODEX_DEFAULT_LIMIT: &str = "codex";
/// JSON-RPC invalid request: Codex's answer without a ChatGPT login.
const CODEX_NOT_SUBSCRIBED: i64 = -32600;

/// `--safe-mode` skips hooks, MCP servers, and plugins, keeping the login.
/// `--bare` wouldn't: it never reads OAuth credentials.
const CLAUDE_ARGS: &[&str] = &[
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
];
const CODEX_ARGS: &[&str] = &["app-server"];

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum LimitSeverity {
    Normal,
    Warning,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentLimit {
    pub label: String,
    pub percent: f64,
    /// Unix seconds.
    pub resets_at: Option<f64>,
    pub severity: LimitSeverity,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentLimits {
    pub agent: String,
    /// As the CLI reports it, e.g. `max` or `prolite`.
    pub plan: Option<String>,
    /// Unix seconds of the last successful read.
    pub updated_at: f64,
    pub limits: Vec<AgentLimit>,
}

/// `Ok(None)` means no limits apply, such as with an API key or no login.
type Read = Result<Option<AgentLimits>, String>;

#[derive(Default)]
struct Slot {
    limits: Option<AgentLimits>,
    read_at: Option<Instant>,
    /// Logged once per change, as tabs poll every minute.
    error: Option<String>,
}

impl Slot {
    fn update(&mut self, read: Read, now: Instant) {
        match read {
            Ok(limits) => {
                self.limits = limits;
                self.read_at = Some(now);
                self.error = None;
            }
            Err(error) => {
                if self.error.as_ref() != Some(&error) {
                    tracing::warn!("agent limits: {error}");
                    self.error = Some(error);
                }
                if self
                    .read_at
                    .is_none_or(|at| now.duration_since(at) >= KEEP_AFTER_FAILURE)
                {
                    self.limits = None;
                }
            }
        }
    }
}

#[derive(Default)]
struct Cache {
    fetched_at: Option<Instant>,
    claude: Slot,
    codex: Slot,
}

/// Held across a read, so concurrent tabs share it.
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);
/// Shared with the Health tab, so it finds the CLIs where limits run them.
static SHELL_PATH: LazyLock<Mutex<ShellPath>> = LazyLock::new(Mutex::default);

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/agent-limits", get(limits))
}

async fn limits(State(state): State<AppState>) -> Json<Vec<AgentLimits>> {
    let mut cache = CACHE.lock().await;
    if cache.fetched_at.is_none_or(|at| at.elapsed() >= CACHE_FOR) {
        let shell = state.read().await.shell().to_owned();
        let [claude, codex] = agent_paths(&shell).await;
        let (claude, codex) = tokio::join!(read_claude(claude), read_codex(codex));
        let now = Instant::now();
        cache.claude.update(claude, now);
        cache.codex.update(codex, now);
        cache.fetched_at = Some(now);
    }
    Json(
        [&cache.claude, &cache.codex]
            .into_iter()
            .filter_map(|slot| slot.limits.clone())
            .collect(),
    )
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// The `PATH` the Claude and Codex CLIs run with, `None` for the server's own.
pub(crate) async fn agent_paths(shell: &str) -> [Option<OsString>; 2] {
    let server = std::env::var_os("PATH");
    let mut shell_path = SHELL_PATH.lock().await;
    let shell_path = shell_path
        .refresh(shell, server.as_deref(), Instant::now())
        .await;
    [Agent::Claude, Agent::Codex]
        .map(|agent| agent_path(&agent_program(agent), server.as_deref(), shell_path))
}

/// `program` in `path`, as exec would find it.
pub(crate) fn find_in(program: &OsStr, path: &OsStr) -> Option<std::path::PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join(program))
        .find(|file| is_executable(file))
}

fn agent_program(agent: Agent) -> OsString {
    agent_launch::program(agent, &|key| std::env::var_os(key))
}

fn on_path(program: &OsStr, path: &OsStr) -> bool {
    find_in(program, path).is_some()
}

/// Whether exec would run it; its `PATH` search skips anything else.
#[cfg(unix)]
fn is_executable(file: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(file.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid C string for the duration of the call.
    file.is_file() && unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0
}

#[cfg(not(unix))]
fn is_executable(file: &Path) -> bool {
    file.is_file()
}

/// The `PATH` for a CLI the server's own can't find.
fn agent_path(program: &OsStr, server: Option<&OsStr>, shell: Option<&OsStr>) -> Option<OsString> {
    if server.is_some_and(|path| on_path(program, path)) {
        return None;
    }
    shell.map(Into::into)
}

/// The `PATH` panes get. A service's lacks what shell startup adds, like `~/.local/bin`.
#[derive(Default)]
struct ShellPath {
    value: Option<OsString>,
    asked_at: Option<Instant>,
}

impl ShellPath {
    /// Asks only while a CLI is on neither `PATH`, starting no shell when both are found.
    async fn refresh(
        &mut self,
        shell: &str,
        server: Option<&OsStr>,
        now: Instant,
    ) -> Option<&OsStr> {
        let found = [Agent::Claude, Agent::Codex].into_iter().all(|agent| {
            let program = agent_program(agent);
            [server, self.value.as_deref()]
                .into_iter()
                .flatten()
                .any(|path| on_path(&program, path))
        });
        let due = self
            .asked_at
            .is_none_or(|at| now.duration_since(at) >= SHELL_PATH_RETRY);
        if !found && due {
            self.asked_at = Some(now);
            match shell_path(shell, SHELL_PATH_TIMEOUT).await {
                Ok(path) => self.value = Some(path),
                Err(error) => tracing::warn!("agent limits: no PATH from {shell}: {error}"),
            }
        }
        self.value.as_deref()
    }
}

#[cfg(unix)]
async fn shell_path(shell: &str, timeout: Duration) -> Result<OsString, String> {
    let mut command = Command::new(shell);
    command
        // Interactive but not login, as panes start it: the two read different files.
        .args([
            "-i",
            "-c",
            &format!("echo {SHELL_PATH_MARKER}; exec printenv PATH"),
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // SAFETY: only an async-signal-safe call. No controlling terminal, or an
    // interactive shell would take over the one the server runs in.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    // `setsid` made it a group leader. Startup may wait on a child, which must die with it.
    let tree = crate::health::ProcessTree::new(&child);
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if let Some(tree) = tree {
        tree.release();
    }
    parse_shell_path(&output.stdout).ok_or_else(|| "no PATH in its output".into())
}

#[cfg(not(unix))]
async fn shell_path(_shell: &str, _timeout: Duration) -> Result<OsString, String> {
    Err("unsupported".into())
}

#[cfg(unix)]
fn parse_shell_path(output: &[u8]) -> Option<OsString> {
    use std::os::unix::ffi::OsStrExt;
    let mut lines = output.split(|byte| *byte == b'\n');
    lines.find(|line| line.ends_with(SHELL_PATH_MARKER.as_bytes()))?;
    let path = OsStr::from_bytes(lines.next()?);
    // Others would resolve against the CLI's working directory, the shared temp dir.
    let dirs: Vec<_> = std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .collect();
    if dirs.is_empty() {
        return None;
    }
    std::env::join_paths(dirs).ok()
}

async fn read_claude(path: Option<OsString>) -> Read {
    let reply = exchange(
        agent_program(Agent::Claude),
        path,
        CLAUDE_ARGS,
        &[json!({
            "type": "control_request",
            "request_id": "usage",
            "request": { "subtype": "get_usage", "skip_behaviors": true },
        })],
        READ_TIMEOUT,
        |mut message| {
            (message["type"] == "control_response" && message["response"]["request_id"] == "usage")
                .then(|| message["response"].take())
        },
    )
    .await?;
    if reply["subtype"] != "success" {
        return Err("Claude Code refused get_usage".into());
    }
    parse_claude(&reply["response"], now_seconds())
}

async fn read_codex(path: Option<OsString>) -> Read {
    let reply = exchange(
        agent_program(Agent::Codex),
        path,
        CODEX_ARGS,
        &[
            json!({
                "id": 1,
                "method": "initialize",
                "params": { "clientInfo": { "name": "btmux", "version": env!("CARGO_PKG_VERSION") } },
            }),
            json!({ "method": "initialized" }),
            json!({
                "id": 2,
                "method": "account/rateLimits/read",
                "params": { "excludeResetCreditDetails": true },
            }),
        ],
        READ_TIMEOUT,
        |message| (message["id"] == 2).then_some(message),
    )
    .await?;
    parse_codex(&reply, now_seconds())
}

/// Writes one JSON line per request, then returns the first output line `reply` accepts.
async fn exchange(
    program: OsString,
    path: Option<OsString>,
    args: &[&str],
    requests: &[Value],
    timeout: Duration,
    mut reply: impl FnMut(Value) -> Option<Value>,
) -> Result<Value, String> {
    let name = program.to_string_lossy().into_owned();
    let mut command = Command::new(program);
    command
        .args(args)
        // Outside any project, whose settings could apply.
        .current_dir(std::env::temp_dir())
        // Set when the server runs inside `btmux claude`; this is not that agent's usage.
        .env_remove("CLAUDE_CODE_ENABLE_TELEMETRY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Also where Unix looks for `program`.
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|error| format!("{name}: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let talk = async {
        let mut input = String::new();
        for request in requests {
            input.push_str(&request.to_string());
            input.push('\n');
        }
        let written = async {
            stdin.write_all(input.as_bytes()).await?;
            stdin.flush().await
        };
        // A program that closed its stdin may still reply; EOF reports one that didn't.
        match written.await {
            Err(error) if error.kind() != ErrorKind::BrokenPipe => return Err(error.to_string()),
            _ => {}
        }
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let Ok(message) = serde_json::from_str(&line) else {
                continue;
            };
            if let Some(value) = reply(message) {
                return Ok(value);
            }
        }
        Err("exited without a reply".to_string())
    };
    let result = tokio::time::timeout(timeout, talk)
        .await
        .unwrap_or_else(|_| Err("timed out".into()))
        .map_err(|error| format!("{name}: {error}"));
    // EOF ends both CLIs cleanly; dropping `child` kills one that doesn't stop.
    drop(stdin);
    let _ = tokio::time::timeout(EXIT_TIMEOUT, child.wait()).await;
    result
}

fn parse_claude(usage: &Value, now: f64) -> Read {
    if usage["rate_limits_available"] != true {
        return Ok(None);
    }
    // Null also while Claude Code's own usage fetch is failing.
    let rows = usage["rate_limits"]["limits"]
        .as_array()
        .ok_or("Claude Code reported no usage rows")?;
    let limits: Vec<_> = rows.iter().filter_map(claude_limit).collect();
    Ok((!limits.is_empty()).then(|| AgentLimits {
        agent: "Claude Code".into(),
        plan: usage["subscription_type"].as_str().map(Into::into),
        updated_at: now,
        limits,
    }))
}

/// Rows keep the server's order, so a new meter needs no change here.
fn claude_limit(row: &Value) -> Option<AgentLimit> {
    let scope = &row["scope"];
    let scope = scope["model"]["display_name"]
        .as_str()
        .or_else(|| scope["surface"]["display_name"].as_str());
    let base = match row["kind"].as_str()? {
        "session" => "Current session".to_string(),
        "weekly_all" | "weekly_scoped" => "Current week".to_string(),
        kind => capitalized(&kind.replace('_', " ")),
    };
    Some(AgentLimit {
        label: match scope {
            Some(scope) => format!("{base} ({scope})"),
            None => base,
        },
        percent: row["percent"].as_f64()?.clamp(0.0, 100.0),
        resets_at: row["resets_at"]
            .as_str()
            .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
            .map(|at| at.unix_timestamp() as f64),
        severity: match row["severity"].as_str() {
            Some("critical") => LimitSeverity::Critical,
            Some("warning") => LimitSeverity::Warning,
            _ => LimitSeverity::Normal,
        },
    })
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

fn parse_codex(reply: &Value, now: f64) -> Read {
    if !reply["error"].is_null() {
        return if reply["error"]["code"] == CODEX_NOT_SUBSCRIBED {
            Ok(None)
        } else {
            Err("Codex could not read rate limits".into())
        };
    }
    let result = &reply["result"];
    if !result.is_object() {
        return Err("Codex sent no rate limits".into());
    }
    let mut snapshots: Vec<(&String, &Value)> = result["rateLimitsByLimitId"]
        .as_object()
        .map(|buckets| buckets.iter().collect())
        .unwrap_or_default();
    snapshots.sort_by_key(|(id, _)| (id.as_str() != CODEX_DEFAULT_LIMIT, id.as_str()));
    let snapshots: Vec<&Value> = if snapshots.is_empty() {
        vec![&result["rateLimits"]]
    } else {
        snapshots
            .into_iter()
            .map(|(_, snapshot)| snapshot)
            .collect()
    };
    let plan = snapshots
        .iter()
        .find_map(|snapshot| snapshot["planType"].as_str())
        .filter(|plan| *plan != "unknown");
    let limits: Vec<_> = snapshots
        .iter()
        .flat_map(|snapshot| {
            [&snapshot["primary"], &snapshot["secondary"]]
                .into_iter()
                .filter_map(|window| codex_limit(snapshot, window))
        })
        .collect();
    Ok((!limits.is_empty()).then(|| AgentLimits {
        agent: "Codex".into(),
        plan: plan.map(Into::into),
        updated_at: now,
        limits,
    }))
}

/// Named by duration, since the weekly window can be `primary` or `secondary`.
fn codex_limit(snapshot: &Value, window: &Value) -> Option<AgentLimit> {
    let percent = window["usedPercent"].as_f64()?.clamp(0.0, 100.0);
    let base = window["windowDurationMins"]
        .as_u64()
        .map_or("Limit".to_string(), window_label);
    let name = snapshot["limitName"].as_str().or_else(|| {
        snapshot["limitId"]
            .as_str()
            .filter(|id| *id != CODEX_DEFAULT_LIMIT)
    });
    Some(AgentLimit {
        label: match name {
            Some(name) => format!("{base} ({name})"),
            None => base,
        },
        percent,
        resets_at: window["resetsAt"].as_f64(),
        severity: if percent >= 100.0 {
            LimitSeverity::Critical
        } else if percent >= CODEX_WARNING_PERCENT {
            LimitSeverity::Warning
        } else {
            LimitSeverity::Normal
        },
    })
}

fn window_label(minutes: u64) -> String {
    const WEEK: u64 = 7 * 24 * 60;
    const DAY: u64 = 24 * 60;
    match minutes {
        WEEK => "Weekly".into(),
        minutes if minutes % DAY == 0 => format!("{}-day", minutes / DAY),
        minutes if minutes % 60 == 0 => format!("{}-hour", minutes / 60),
        minutes => format!("{minutes}-minute"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_000.0;

    fn limit(label: &str, percent: f64, resets_at: Option<f64>) -> AgentLimit {
        AgentLimit {
            label: label.into(),
            percent,
            resets_at,
            severity: LimitSeverity::Normal,
        }
    }

    #[test]
    fn claude_rows_keep_the_server_order_and_scope() {
        let usage = json!({
            "subscription_type": "max",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 99 },
                "limits": [
                    { "kind": "session", "group": "session", "percent": 20, "severity": "normal",
                      "resets_at": "2026-11-04T10:30:00.149117+00:00", "scope": null },
                    { "kind": "weekly_all", "group": "weekly", "percent": 85.5, "severity": "warning",
                      "resets_at": "2026-11-09T14:00:00+00:00", "scope": null },
                    { "kind": "weekly_scoped", "group": "weekly", "percent": 100, "severity": "critical",
                      "resets_at": null, "scope": { "model": { "display_name": "Fable" }, "surface": null } },
                    { "kind": "weekly_scoped", "percent": 0, "severity": "new_grade",
                      "scope": { "model": null, "surface": { "display_name": "Cowork" } } },
                    { "kind": "monthly_all", "percent": 1, "severity": "normal" },
                    { "kind": "no_percent" },
                    { "percent": 3 },
                ],
            },
        });
        let parsed = parse_claude(&usage, NOW).unwrap().unwrap();
        assert_eq!(parsed.agent, "Claude Code");
        assert_eq!(parsed.plan.as_deref(), Some("max"));
        assert_eq!(parsed.updated_at, NOW);
        assert_eq!(
            parsed.limits,
            [
                limit("Current session", 20.0, Some(1_793_788_200.0)),
                AgentLimit {
                    severity: LimitSeverity::Warning,
                    ..limit("Current week", 85.5, Some(1_794_232_800.0))
                },
                AgentLimit {
                    severity: LimitSeverity::Critical,
                    ..limit("Current week (Fable)", 100.0, None)
                },
                limit("Current week (Cowork)", 0.0, None),
                limit("Monthly all", 1.0, None),
            ]
        );
    }

    #[test]
    fn claude_without_a_subscription_has_no_limits() {
        for usage in [
            json!({ "subscription_type": null, "rate_limits_available": false, "rate_limits": null }),
            json!({}),
            json!({ "rate_limits_available": true, "rate_limits": { "limits": [] } }),
        ] {
            assert_eq!(parse_claude(&usage, NOW), Ok(None));
        }
    }

    #[test]
    fn claude_failing_its_usage_fetch_is_a_failure() {
        let usage = json!({ "rate_limits_available": true, "rate_limits": { "limits": null } });
        assert!(parse_claude(&usage, NOW).is_err());
    }

    #[test]
    fn codex_names_windows_by_duration() {
        let reply = json!({ "id": 2, "result": { "rateLimits": {
            "limitId": "codex",
            "limitName": null,
            "primary": { "usedPercent": 8, "windowDurationMins": 10080, "resetsAt": 1_793_820_155 },
            "secondary": null,
            "planType": "prolite",
        } } });
        let parsed = parse_codex(&reply, NOW).unwrap().unwrap();
        assert_eq!(parsed.agent, "Codex");
        assert_eq!(parsed.plan.as_deref(), Some("prolite"));
        assert_eq!(parsed.limits, [limit("Weekly", 8.0, Some(1_793_820_155.0))]);
    }

    #[test]
    fn codex_lists_the_default_bucket_first_and_grades_windows() {
        let reply = json!({ "result": {
            "rateLimits": { "primary": { "usedPercent": 1, "windowDurationMins": 1 } },
            "rateLimitsByLimitId": {
                "another": {
                    "limitId": "another",
                    "limitName": null,
                    "primary": { "usedPercent": 150, "windowDurationMins": 1440 },
                    "planType": "unknown",
                },
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 80, "windowDurationMins": 300, "resetsAt": null },
                    "secondary": { "usedPercent": 79.5, "windowDurationMins": 10080 },
                    "planType": "plus",
                },
                "spark": {
                    "limitId": "spark",
                    "limitName": "Spark",
                    "primary": { "usedPercent": 2, "windowDurationMins": null },
                    "secondary": { "usedPercent": 2, "windowDurationMins": 45 },
                },
            },
        } });
        let parsed = parse_codex(&reply, NOW).unwrap().unwrap();
        assert_eq!(parsed.plan.as_deref(), Some("plus"));
        assert_eq!(
            parsed.limits,
            [
                AgentLimit {
                    severity: LimitSeverity::Warning,
                    ..limit("5-hour", 80.0, None)
                },
                limit("Weekly", 79.5, None),
                AgentLimit {
                    severity: LimitSeverity::Critical,
                    ..limit("1-day (another)", 100.0, None)
                },
                limit("Limit (Spark)", 2.0, None),
                limit("45-minute (Spark)", 2.0, None),
            ]
        );
    }

    #[test]
    fn codex_needs_a_chatgpt_login() {
        let reply =
            json!({ "error": { "code": -32600, "message": "chatgpt authentication required" } });
        assert_eq!(parse_codex(&reply, NOW), Ok(None));
        let no_windows =
            json!({ "result": { "rateLimits": { "primary": null, "secondary": null } } });
        assert_eq!(parse_codex(&no_windows, NOW), Ok(None));
    }

    #[test]
    fn codex_failures_are_not_an_absent_login() {
        assert!(parse_codex(&json!({ "error": { "code": -32603 } }), NOW).is_err());
        assert!(parse_codex(&json!({ "id": 2 }), NOW).is_err());
    }

    #[test]
    fn failures_keep_recent_limits_until_they_expire() {
        let start = Instant::now();
        let limits = AgentLimits {
            agent: "Codex".into(),
            plan: None,
            updated_at: NOW,
            limits: vec![limit("Weekly", 1.0, None)],
        };
        let mut slot = Slot::default();
        slot.update(Err("offline".into()), start);
        assert_eq!(slot.limits, None);
        slot.update(Ok(Some(limits.clone())), start);
        slot.update(
            Err("offline".into()),
            start + KEEP_AFTER_FAILURE - Duration::from_secs(1),
        );
        assert_eq!(slot.limits.as_ref(), Some(&limits));
        slot.update(Err("offline".into()), start + KEEP_AFTER_FAILURE);
        assert_eq!(slot.limits, None);
        // A logout takes effect at once.
        slot.update(Ok(Some(limits)), start);
        slot.update(Ok(None), start);
        assert_eq!(slot.limits, None);
        assert_eq!(slot.error, None);
    }

    #[cfg(unix)]
    mod exchange {
        use super::*;
        use crate::health::tests::{assert_child_exits, spawns_child, test_script, CHILD_STARTED};

        async fn run(script: &str, timeout: Duration) -> Result<Value, String> {
            let args = ["-c", script];
            super::super::exchange(
                "sh".into(),
                None,
                &args,
                &[json!({ "ping": 1 }), json!({ "ping": 2 })],
                timeout,
                |message| (message["reply"] == true).then_some(message),
            )
            .await
        }

        #[tokio::test]
        async fn skips_other_output_and_returns_the_reply() {
            let reply = run(
                r#"read a; read b; echo noise; echo '{"reply":false}'; echo "{\"reply\":true,\"got\":$b}""#,
                Duration::from_secs(10),
            )
            .await
            .unwrap();
            assert_eq!(reply["got"]["ping"], 2);
        }

        #[tokio::test]
        async fn fails_when_the_program_exits_or_hangs() {
            let exited = run("exit 0", Duration::from_secs(10)).await.unwrap_err();
            assert!(exited.contains("without a reply"), "{exited}");
            let started = Instant::now();
            let hung = run("while :; do sleep 1; done", Duration::from_millis(50))
                .await
                .unwrap_err();
            assert!(hung.contains("timed out"), "{hung}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        // More than a pipe holds, so the write always outlives the program.
        async fn run_unread(script: &str) -> Result<Value, String> {
            super::super::exchange(
                "sh".into(),
                None,
                &["-c", script],
                &[json!("x".repeat(1 << 20))],
                Duration::from_secs(10),
                |message| (message["reply"] == true).then_some(message),
            )
            .await
        }

        #[tokio::test]
        async fn reads_the_output_of_a_program_that_ignores_its_input() {
            let reply = run_unread(r#"echo '{"reply":true}'"#).await.unwrap();
            assert_eq!(reply["reply"], true);
            let exited = run_unread("exit 0").await.unwrap_err();
            assert!(exited.contains("without a reply"), "{exited}");
        }

        #[tokio::test]
        async fn fails_when_the_program_is_missing() {
            let error = super::super::exchange(
                "btmux-no-such-agent".into(),
                None,
                &[],
                &[],
                Duration::from_secs(5),
                Some,
            )
            .await
            .unwrap_err();
            assert!(error.contains("btmux-no-such-agent"), "{error}");
        }

        #[tokio::test]
        async fn finds_the_program_on_the_given_path() {
            let dir = std::env::temp_dir().join(format!("btmux-limits-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            // A link, since running a just-written script can fail with ETXTBSY.
            let sh = crate::vscode::find_on_path("sh").unwrap();
            std::os::unix::fs::symlink(sh, dir.join("btmux-test-agent")).unwrap();
            let reply = super::super::exchange(
                "btmux-test-agent".into(),
                Some(dir.clone().into()),
                &["-c", r#"echo '{"reply":true}'"#],
                &[],
                Duration::from_secs(10),
                Some,
            )
            .await;
            std::fs::remove_dir_all(dir).unwrap();
            assert_eq!(reply.unwrap()["reply"], true);
        }

        #[tokio::test]
        async fn asks_the_shell_for_its_path() {
            let path = shell_path("sh", Duration::from_secs(10)).await.unwrap();
            assert!(!path.is_empty());
            assert!(shell_path("sh", Duration::ZERO).await.is_err());
            assert!(shell_path("btmux-no-such-shell", Duration::from_secs(10))
                .await
                .is_err());
        }

        #[test]
        fn parses_the_path_after_startup_noise() {
            assert_eq!(
                parse_shell_path(b"welcome\n\x1b[6 q__btmux_path__\n/a/b:/c\n"),
                Some("/a/b:/c".into())
            );
            for path in [".:/a/b:/c", ":/a/b:/c", "/a/b::rel:/c:"] {
                let output = format!("__btmux_path__\n{path}\n");
                assert_eq!(
                    parse_shell_path(output.as_bytes()),
                    Some("/a/b:/c".into()),
                    "{path}"
                );
            }
            for output in [
                &b"/a/b:/c\n"[..],
                b"__btmux_path__\n",
                b"__btmux_path__\n\n",
                b"__btmux_path__\nnot a path\n",
                b"__btmux_path__\n.:rel:\n",
            ] {
                assert_eq!(parse_shell_path(output), None);
            }
        }

        #[tokio::test]
        async fn shell_path_timeouts_kill_descendants() {
            for end in ["wait", "exit 0"] {
                let (dir, shell) = test_script(&spawns_child(end), 0o755);
                let shell = shell.to_str().unwrap();
                assert!(shell_path(shell, CHILD_STARTED).await.is_err());
                assert_child_exits(&dir).await;
                std::fs::remove_dir_all(&dir).unwrap();
            }
        }

        #[tokio::test]
        async fn cancelling_shell_path_kills_descendants() {
            let (dir, shell) = test_script(&spawns_child("wait"), 0o755);
            let asked = shell_path(shell.to_str().unwrap(), Duration::from_secs(30));
            assert!(tokio::time::timeout(CHILD_STARTED, asked).await.is_err());
            assert_child_exits(&dir).await;
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[tokio::test]
        async fn shell_path_leaves_background_jobs_of_a_shell_that_answered() {
            let (dir, shell) = test_script(
                &format!(
                    "/bin/sleep 60 >/dev/null 2>&1 &\necho $! > \"$0.child\"\n\
                     echo {SHELL_PATH_MARKER}\necho /a/b"
                ),
                0o755,
            );
            let path = shell_path(shell.to_str().unwrap(), Duration::from_secs(30)).await;
            assert_eq!(path.unwrap(), "/a/b");
            let pid: libc::pid_t = std::fs::read_to_string(dir.join("tool.child"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // SAFETY: signal 0 only checks; SIGKILL goes to the test's own child.
            unsafe {
                assert_eq!(libc::kill(pid, 0), 0, "the job should still run");
                libc::kill(pid, libc::SIGKILL);
            }
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn only_a_cli_the_server_cannot_find_gets_the_shell_path() {
            let sh = OsStr::new("sh");
            let server = std::env::var_os("PATH").unwrap();
            let shell = OsStr::new("/shell/bin");
            assert_eq!(agent_path(sh, Some(&server), Some(shell)), None);
            assert_eq!(
                agent_path(
                    OsStr::new("btmux-no-such-agent"),
                    Some(&server),
                    Some(shell)
                ),
                Some(shell.into())
            );
            assert_eq!(agent_path(sh, None, Some(shell)), Some(shell.into()));
            assert_eq!(
                agent_path(OsStr::new("btmux-no-such-agent"), Some(&server), None),
                None
            );
        }

        #[test]
        fn a_file_it_cannot_execute_is_not_on_the_path() {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("btmux-limits-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("folder")).unwrap();
            let file = dir.join("file");
            std::fs::write(&file, "").unwrap();
            let set_mode = |mode| {
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            };
            let path = dir.as_os_str();
            let shell = OsStr::new("/shell/bin");

            set_mode(0o644);
            assert!(!on_path(OsStr::new("file"), path));
            assert_eq!(
                agent_path(OsStr::new("file"), Some(path), Some(shell)),
                Some(shell.into())
            );
            set_mode(0o755);
            assert!(on_path(OsStr::new("file"), path));
            assert_eq!(
                agent_path(OsStr::new("file"), Some(path), Some(shell)),
                None
            );
            assert!(!on_path(OsStr::new("folder"), path));
            std::fs::remove_dir_all(dir).unwrap();
        }

        #[tokio::test]
        async fn asks_the_shell_once_until_the_retry_is_due() {
            let start = Instant::now();
            let empty = OsStr::new("/btmux-no-such-dir");
            let mut path = ShellPath::default();
            // A shell that can't start leaves nothing, and isn't run again before the retry.
            path.refresh("btmux-no-such-shell", Some(empty), start)
                .await;
            let asked = path.asked_at;
            assert_eq!(asked, Some(start));
            path.refresh("sh", Some(empty), start + Duration::from_secs(1))
                .await;
            assert_eq!(path.asked_at, asked);
            assert_eq!(path.value, None);
            let later = start + SHELL_PATH_RETRY;
            assert!(path.refresh("sh", Some(empty), later).await.is_some());
            assert_eq!(path.asked_at, Some(later));
        }
    }
}
