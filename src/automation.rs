//! Pane and agent automation shared by REST, MCP, and the CLI.

use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::Instant;
use uuid::Uuid;

use crate::pty::screen::{self, MAX_CAPTURE_HISTORY};
use crate::session::{AgentState, AgentStatus};
use crate::{config, AppState};

pub const DEFAULT_WAIT: Duration = Duration::from_secs(600);
pub const MAX_WAIT: Duration = Duration::from_secs(3600);
/// States in which an agent waits for its user.
pub const SETTLED: [AgentState; 3] = [AgentState::Idle, AgentState::Done, AgentState::Blocked];
/// Agent input boxes can drop an Enter that arrives with the pasted text.
const SUBMIT_DELAY: Duration = Duration::from_millis(300);
/// How long a submitted prompt may take to start a turn.
const START_TIMEOUT: Duration = Duration::from_secs(15);

pub enum Error {
    PaneNotFound(Uuid),
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PaneNotFound(pane_id) => write!(f, "pane {pane_id} not found"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

pub fn wait_duration(timeout_ms: Option<u64>) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_WAIT)
        .min(MAX_WAIT)
}

/// Parses agent state names such as `idle`.
pub fn parse_states<S: AsRef<str>>(names: &[S]) -> Result<Vec<AgentState>, String> {
    names
        .iter()
        .map(|name| {
            serde_json::from_value(serde_json::Value::String(name.as_ref().to_owned()))
                .map_err(|_| format!("unknown agent state: {}", name.as_ref()))
        })
        .collect()
}

/// The pane's rendered screen, with up to `lines` lines (or all retained
/// history) above it when `history` is set, then cut to the last `lines`.
pub async fn capture_pane(
    state: &AppState,
    pane_id: Uuid,
    history: bool,
    lines: Option<usize>,
) -> Result<String, Error> {
    let events = {
        let mut mgr = state.write().await;
        let pane = mgr
            .find_pane_mut(pane_id)
            .ok_or(Error::PaneNotFound(pane_id))?;
        pane.pty
            .ensure_spawned(config::DEFAULT_PTY_COLS, config::DEFAULT_PTY_ROWS)?;
        pane.pty.journal()
    };
    let rows = if history {
        lines.unwrap_or(MAX_CAPTURE_HISTORY)
    } else {
        0
    };
    let text = tokio::task::spawn_blocking(move || screen::capture(&events, rows).text)
        .await
        .map_err(|e| Error::Failed(e.to_string()))?;
    Ok(match lines {
        Some(lines) => last_lines(&text, lines),
        None => text,
    })
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut tail = lines[lines.len().saturating_sub(count)..].join("\n");
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail
}

#[derive(Serialize)]
pub struct AgentWait {
    /// None once the agent has exited.
    pub status: Option<AgentStatus>,
    pub timed_out: bool,
}

/// Waits until the pane's agent is in one of `states` or has exited. A pane
/// with no agent yet is waited on, so this can follow launching one.
pub async fn wait_for_agent(
    state: &AppState,
    pane_id: Uuid,
    states: &[AgentState],
    timeout: Duration,
) -> Result<AgentWait, Error> {
    let mut events = state.read().await.events().subscribe();
    wait_until(
        state,
        pane_id,
        &mut events,
        |s| states.contains(s),
        Instant::now() + timeout,
    )
    .await
}

/// Rechecks on every state broadcast, since each agent status change sends one.
async fn wait_until(
    state: &AppState,
    pane_id: Uuid,
    events: &mut broadcast::Receiver<String>,
    done: impl Fn(&AgentState) -> bool,
    deadline: Instant,
) -> Result<AgentWait, Error> {
    let mut seen = false;
    loop {
        let status = {
            let mgr = state.read().await;
            if mgr.find_pane(pane_id).is_none() {
                return Err(Error::PaneNotFound(pane_id));
            }
            mgr.agent_status(pane_id).cloned()
        };
        match &status {
            Some(current) if done(&current.state) => {
                return Ok(AgentWait {
                    status,
                    timed_out: false,
                })
            }
            Some(_) => seen = true,
            None if seen => {
                return Ok(AgentWait {
                    status,
                    timed_out: false,
                })
            }
            None => {}
        }
        tokio::select! {
            event = events.recv() => match event {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return Err("server is shutting down".into()),
            },
            _ = tokio::time::sleep_until(deadline) => {
                return Ok(AgentWait { status, timed_out: true });
            }
        }
    }
}

#[derive(Serialize)]
pub struct PromptOutcome {
    /// None once the agent has exited.
    pub status: Option<AgentStatus>,
    /// Whether the agent was seen working on the prompt.
    pub started: bool,
    pub timed_out: bool,
    /// The rendered screen when the call returned.
    pub screen: String,
}

/// Pastes `prompt` into the pane's agent and submits it. With `wait`, waits
/// for the agent to start and then settle (idle, done, or blocked).
pub async fn send_prompt(
    state: &AppState,
    pane_id: Uuid,
    prompt: &str,
    wait: bool,
    timeout: Duration,
) -> Result<PromptOutcome, Error> {
    let (input, journal) = {
        let mgr = state.read().await;
        let pane = mgr.find_pane(pane_id).ok_or(Error::PaneNotFound(pane_id))?;
        let status = mgr
            .agent_status(pane_id)
            .ok_or("no agent detected in this pane; use send_keys")?;
        if status.state == AgentState::Blocked {
            // Typed text would answer the pending dialog.
            return Err(
                "the agent is waiting for a decision; read the pane and answer it with send_keys"
                    .into(),
            );
        }
        (pane.pty.input_tx.clone(), pane.pty.journal())
    };
    let bracketed =
        tokio::task::spawn_blocking(move || screen::capture(&journal, 0).bracketed_paste)
            .await
            .map_err(|e| Error::Failed(e.to_string()))?;
    let text = prompt.trim_end_matches(['\r', '\n']);
    let paste = if bracketed {
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
    } else if text.contains(['\r', '\n']) {
        return Err("the pane doesn't accept pasted text, so a newline would submit early".into());
    } else {
        text.to_owned()
    };

    let mut events = state.read().await.events().subscribe();
    let deadline = Instant::now() + timeout;
    input.send_wait(paste.into_bytes()).await?;
    tokio::time::sleep(SUBMIT_DELAY).await;
    input.send_wait(b"\r".to_vec()).await?;

    let mut started = false;
    let mut outcome = AgentWait {
        status: None,
        timed_out: false,
    };
    if wait {
        let start = deadline.min(Instant::now() + START_TIMEOUT);
        outcome = wait_until(
            state,
            pane_id,
            &mut events,
            |s| matches!(s, AgentState::Working | AgentState::Blocked),
            start,
        )
        .await?;
        started = !outcome.timed_out && outcome.status.is_some();
        if started {
            outcome = wait_until(
                state,
                pane_id,
                &mut events,
                |s| SETTLED.contains(s),
                deadline,
            )
            .await?;
        }
    } else {
        outcome.status = state.read().await.agent_status(pane_id).cloned();
    }
    Ok(PromptOutcome {
        status: outcome.status,
        started,
        timed_out: outcome.timed_out,
        screen: capture_pane(state, pane_id, false, None).await?,
    })
}

/// Encodes tmux-style key names (`Enter`, `C-c`, `M-x`, `Up`, `F5`) as the
/// bytes a terminal sends.
pub fn encode_keys<S: AsRef<str>>(keys: &[S]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for key in keys {
        let key = key.as_ref();
        bytes.extend(encode_key(key).ok_or_else(|| format!("unknown key: {key}"))?);
    }
    Ok(bytes)
}

fn encode_key(key: &str) -> Option<Vec<u8>> {
    if let Some(rest) = key.strip_prefix("M-") {
        let mut bytes = vec![0x1b];
        bytes.extend(encode_key(rest)?);
        return Some(bytes);
    }
    if let Some(rest) = key.strip_prefix("C-") {
        return control(rest).map(|byte| vec![byte]);
    }
    let named: &[u8] = match key.to_ascii_lowercase().as_str() {
        "enter" => b"\r",
        "tab" => b"\t",
        "btab" => b"\x1b[Z",
        "escape" | "esc" => b"\x1b",
        "space" => b" ",
        "bspace" | "backspace" => b"\x7f",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "ic" | "insert" => b"\x1b[2~",
        "dc" | "delete" => b"\x1b[3~",
        "ppage" | "pageup" | "pgup" => b"\x1b[5~",
        "npage" | "pagedown" | "pgdn" => b"\x1b[6~",
        "f1" => b"\x1bOP",
        "f2" => b"\x1bOQ",
        "f3" => b"\x1bOR",
        "f4" => b"\x1bOS",
        "f5" => b"\x1b[15~",
        "f6" => b"\x1b[17~",
        "f7" => b"\x1b[18~",
        "f8" => b"\x1b[19~",
        "f9" => b"\x1b[20~",
        "f10" => b"\x1b[21~",
        "f11" => b"\x1b[23~",
        "f12" => b"\x1b[24~",
        _ => {
            let mut chars = key.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) => Some(c.to_string().into_bytes()),
                _ => None,
            };
        }
    };
    Some(named.to_vec())
}

fn control(key: &str) -> Option<u8> {
    if key.eq_ignore_ascii_case("space") {
        return Some(0);
    }
    let mut chars = key.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return None;
    };
    match c {
        'a'..='z' | 'A'..='Z' => Some(c.to_ascii_lowercase() as u8 & 0x1f),
        '@' | ' ' | '2' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '/' | '7' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FileConfig;
    use crate::session::manager::SessionManager;
    use crate::ws::control::broadcast_state;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    async fn pane() -> (AppState, Uuid) {
        let (exit_tx, _) = mpsc::unbounded_channel();
        let (meta_tx, _) = mpsc::unbounded_channel();
        let mut mgr = SessionManager::new(
            "/bin/sh".into(),
            FileConfig::default(),
            exit_tx,
            meta_tx,
            8044,
            None,
        );
        let session = mgr.create_session(None).await;
        let pane_id = mgr.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        mgr.find_pane_mut(pane_id)
            .unwrap()
            .pty
            .ensure_spawned(80, 24)
            .unwrap();
        (Arc::new(RwLock::new(mgr)), pane_id)
    }

    async fn set(state: &AppState, pane_id: Uuid, agent_state: AgentState) {
        let mut mgr = state.write().await;
        mgr.set_agent_status(
            pane_id,
            AgentStatus {
                state: agent_state,
                agent: Some("claude".into()),
                ..AgentStatus::default()
            },
        );
        broadcast_state(&mgr);
    }

    #[tokio::test]
    async fn waits_for_an_agent_to_start_and_settle() {
        let (state, pane_id) = pane().await;
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { wait_for_agent(&state, pane_id, &SETTLED, DEFAULT_WAIT).await }
        });
        set(&state, pane_id, AgentState::Working).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiter.is_finished());
        set(&state, pane_id, AgentState::Done).await;
        let outcome = waiter.await.unwrap().ok().unwrap();
        assert_eq!(outcome.status.unwrap().state, AgentState::Done);
        assert!(!outcome.timed_out);

        let outcome = wait_for_agent(
            &state,
            pane_id,
            &[AgentState::Working],
            Duration::from_millis(20),
        )
        .await
        .ok()
        .unwrap();
        assert!(outcome.timed_out);
        assert_eq!(outcome.status.unwrap().state, AgentState::Done);
    }

    #[tokio::test]
    async fn send_prompt_waits_for_the_turn() {
        let (state, pane_id) = pane().await;
        let error = send_prompt(&state, pane_id, "hi", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Failed(message)) if message.contains("no agent")));
        set(&state, pane_id, AgentState::Blocked).await;
        let error = send_prompt(&state, pane_id, "hi", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Failed(message)) if message.contains("decision")));
        set(&state, pane_id, AgentState::Idle).await;
        // /bin/sh doesn't enable bracketed paste.
        let error = send_prompt(&state, pane_id, "a\nb", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Failed(message)) if message.contains("newline")));

        let prompt = tokio::spawn({
            let state = state.clone();
            async move { send_prompt(&state, pane_id, "echo btmux-$((6*7))", true, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(SUBMIT_DELAY * 2).await;
        set(&state, pane_id, AgentState::Working).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        set(&state, pane_id, AgentState::Idle).await;
        let outcome = prompt.await.unwrap().ok().unwrap();
        assert!(outcome.started);
        assert!(!outcome.timed_out);
        assert_eq!(outcome.status.unwrap().state, AgentState::Idle);
        let screen = capture_pane(&state, pane_id, true, None)
            .await
            .ok()
            .unwrap();
        assert!(screen.contains("btmux-42"), "{screen}");
    }

    #[test]
    fn encodes_tmux_key_names() {
        assert_eq!(encode_keys(&["C-c"]).unwrap(), b"\x03");
        assert_eq!(
            encode_keys(&["Enter", "M-x", "Up"]).unwrap(),
            b"\r\x1bx\x1b[A"
        );
        assert_eq!(
            encode_keys(&["M-C-a", "C-Space", "q"]).unwrap(),
            b"\x1b\x01\x00q"
        );
        assert_eq!(encode_keys(&["F5", "BTab"]).unwrap(), b"\x1b[15~\x1b[Z");
        assert!(encode_keys(&["Entr"]).is_err());
        assert!(encode_keys(&["C-é"]).is_err());
    }

    #[test]
    fn parses_states_and_keeps_last_lines() {
        assert_eq!(
            parse_states(&["idle", "blocked"]).unwrap(),
            [AgentState::Idle, AgentState::Blocked]
        );
        assert!(parse_states(&["asleep"]).is_err());
        assert_eq!(last_lines("a\nb\nc\n", 2), "b\nc\n");
        assert_eq!(last_lines("a\n", 5), "a\n");
        assert_eq!(last_lines("a\n", 0), "");
    }
}
