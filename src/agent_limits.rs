//! Subscription limits, read from the agent CLIs without sending a prompt.
//!
//! Each read starts the CLI, so it does its own auth and btmux never touches a
//! credential. `GET /api/agent-limits` reads at most once per `CACHE_FOR`, and
//! only tabs showing the limits ask.

use std::ffi::OsString;
use std::io::ErrorKind;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{routing::get, Json, Router};
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
}

impl Slot {
    fn update(&mut self, read: Read, now: Instant) {
        match read {
            Ok(limits) => {
                self.limits = limits;
                self.read_at = Some(now);
            }
            Err(error) => {
                tracing::debug!("agent limits: {error}");
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

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/agent-limits", get(limits))
}

async fn limits() -> Json<Vec<AgentLimits>> {
    let mut cache = CACHE.lock().await;
    if cache.fetched_at.is_none_or(|at| at.elapsed() >= CACHE_FOR) {
        let (claude, codex) = tokio::join!(read_claude(), read_codex());
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

fn agent_program(agent: Agent) -> OsString {
    agent_launch::program(agent, &|key| std::env::var_os(key))
}

async fn read_claude() -> Read {
    let reply = exchange(
        agent_program(Agent::Claude),
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

async fn read_codex() -> Read {
    let reply = exchange(
        agent_program(Agent::Codex),
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
    }

    #[cfg(unix)]
    mod exchange {
        use super::*;

        async fn run(script: &str, timeout: Duration) -> Result<Value, String> {
            let args = ["-c", script];
            super::super::exchange(
                "sh".into(),
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
                &[],
                &[],
                Duration::from_secs(5),
                Some,
            )
            .await
            .unwrap_err();
            assert!(error.contains("btmux-no-such-agent"), "{error}");
        }
    }
}
