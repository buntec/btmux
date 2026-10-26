//! Pane and agent automation shared by REST, MCP, and the CLI.

use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::Instant;
use uuid::Uuid;

use crate::pty::replay::Output;
use crate::pty::screen;
use crate::pty::MAX_INPUT;
use crate::session::manager::{PaneStatuses, SessionManager};
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
/// A pause in output that ends the agent's final redraw.
const OUTPUT_QUIET: Duration = Duration::from_millis(200);
const OUTPUT_SETTLE: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub enum Error {
    PaneNotFound(Uuid),
    /// The request itself is wrong.
    Invalid(String),
    /// The pane's current state doesn't allow it; may succeed later.
    Conflict(String),
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PaneNotFound(pane_id) => write!(f, "pane {pane_id} not found"),
            Self::Invalid(message) | Self::Conflict(message) | Self::Failed(message) => {
                f.write_str(message)
            }
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

/// Parses agent state names such as `idle`, skipping blanks.
pub fn parse_states<S: AsRef<str>>(names: &[S]) -> Result<Vec<AgentState>, String> {
    let states = names
        .iter()
        .map(|name| name.as_ref().trim())
        .filter(|name| !name.is_empty())
        .map(|name| {
            serde_json::from_value(serde_json::Value::String(name.to_owned()))
                .map_err(|_| format!("unknown agent state: {name}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if states.is_empty() {
        return Err("pass at least one agent state".into());
    }
    Ok(states)
}

/// Sends `text` verbatim, then tmux-style `keys`, spawning the pane's shell
/// at `size` if needed. Returns whether it spawned.
pub async fn send_keys<S: AsRef<str>>(
    state: &AppState,
    pane_id: Uuid,
    text: &str,
    keys: &[S],
    size: Option<(u16, u16)>,
) -> Result<bool, Error> {
    // Validates the names before anything spawns.
    let mut bytes = text.as_bytes().to_vec();
    bytes.extend(encode_keys(keys, false).map_err(Error::Invalid)?);
    if bytes.is_empty() {
        return Err(Error::Invalid("pass text or keys".into()));
    }
    if bytes.len() > MAX_INPUT {
        return Err(Error::Invalid(
            "input exceeds 64 KiB; split it into smaller requests".into(),
        ));
    }
    let (cols, rows) = size.unwrap_or((config::DEFAULT_PTY_COLS, config::DEFAULT_PTY_ROWS));
    let (newly_spawned, input, journal) = {
        let mut mgr = state.write().await;
        let pane = mgr
            .find_pane_mut(pane_id)
            .ok_or(Error::PaneNotFound(pane_id))?;
        let newly_spawned = !pane.pty.is_spawned();
        pane.pty.ensure_spawned(cols, rows)?;
        let journal = keys
            .iter()
            .any(|key| cursor_key(key.as_ref()).is_some())
            .then(|| pane.pty.journal());
        (newly_spawned, pane.pty.input_tx.clone(), journal)
    };
    if let Some(journal) = journal {
        let application =
            tokio::task::spawn_blocking(move || screen::capture(&journal, 0).application_cursor)
                .await
                .map_err(|e| Error::Failed(e.to_string()))?;
        if application {
            bytes.truncate(text.len());
            bytes.extend(encode_keys(keys, true).map_err(Error::Invalid)?);
        }
    }
    input.send(bytes)?;
    Ok(newly_spawned)
}

/// The pane's rendered screen, with up to `history` rows of retained history
/// above it, cut to the last `lines`.
pub async fn capture_pane(
    state: &AppState,
    pane_id: Uuid,
    history: usize,
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
    tokio::task::spawn_blocking(move || render(&events, history, lines))
        .await
        .map_err(|e| Error::Failed(e.to_string()))
}

fn render(events: &[Output], history: usize, lines: Option<usize>) -> String {
    // History counts rows, `lines` joined lines.
    let text = screen::capture(events, history).text;
    match lines {
        Some(lines) => last_lines(&text, lines),
        None => text,
    }
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
    let (status, mut events) = {
        let mgr = state.read().await;
        (status_of(&mgr, pane_id)?, mgr.statuses().subscribe())
    };
    wait_until(
        state,
        pane_id,
        status,
        &mut events,
        |s| states.contains(s),
        Instant::now() + timeout,
    )
    .await
}

/// Checks `status`, then each later status broadcast in order, so brief
/// states count and a known agent's absence, or the pane's, is an exit.
async fn wait_until(
    state: &AppState,
    pane_id: Uuid,
    mut status: Option<AgentStatus>,
    events: &mut broadcast::Receiver<PaneStatuses>,
    done: impl Fn(&AgentState) -> bool,
    deadline: Instant,
) -> Result<AgentWait, Error> {
    let mut seen = false;
    loop {
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
        status = tokio::select! {
            event = events.recv() => match event {
                Ok(statuses) => match statuses.get(&pane_id) {
                    Some(status) => status.clone(),
                    None => return Ok(AgentWait { status: None, timed_out: false }),
                },
                Err(broadcast::error::RecvError::Lagged(_)) => match status_of(&*state.read().await, pane_id) {
                    Err(Error::PaneNotFound(_)) => return Ok(AgentWait { status: None, timed_out: false }),
                    status => status?,
                },
                Err(broadcast::error::RecvError::Closed) => return Err("server is shutting down".into()),
            },
            _ = tokio::time::sleep_until(deadline) => {
                return Ok(AgentWait { status, timed_out: true });
            }
        };
    }
}

fn status_of(mgr: &SessionManager, pane_id: Uuid) -> Result<Option<AgentStatus>, Error> {
    if mgr.find_pane(pane_id).is_none() {
        return Err(Error::PaneNotFound(pane_id));
    }
    Ok(mgr.agent_status(pane_id).cloned())
}

#[derive(Serialize)]
pub struct PromptOutcome {
    /// None once the agent has exited.
    pub status: Option<AgentStatus>,
    /// Whether the agent was seen working on the prompt.
    pub started: bool,
    pub timed_out: bool,
    /// The rendered screen once output went quiet; None once the pane has
    /// closed.
    pub screen: Option<String>,
}

fn turn_started(state: &AgentState) -> bool {
    matches!(state, AgentState::Working | AgentState::Blocked)
}

/// Pastes `prompt` into the pane's agent and submits it. With `wait`, waits
/// for the agent to start and then settle (idle, done, or blocked); without,
/// returns None once submitted.
pub async fn send_prompt(
    state: &AppState,
    pane_id: Uuid,
    prompt: &str,
    wait: bool,
    timeout: Duration,
) -> Result<Option<PromptOutcome>, Error> {
    let lock = state
        .read()
        .await
        .find_pane(pane_id)
        .ok_or(Error::PaneNotFound(pane_id))?
        .prompt
        .clone();
    let (exclusive, shared) = if wait {
        (Some(lock.turn.clone().write_owned().await), None)
    } else {
        (None, Some(lock.turn.clone().read_owned().await))
    };
    let submitting = lock.submit.lock().await;
    let (status, input, journal, mut events) = {
        let mgr = state.read().await;
        let pane = mgr.find_pane(pane_id).ok_or(Error::PaneNotFound(pane_id))?;
        let status = mgr.agent_status(pane_id).ok_or_else(|| {
            Error::Conflict("no agent detected in this pane; send keys instead".into())
        })?;
        if status.state == AgentState::Blocked {
            // Typed text would answer the pending dialog.
            return Err(Error::Conflict(
                "the agent is waiting for a decision; read the pane and answer it by sending keys"
                    .into(),
            ));
        }
        if wait && status.state == AgentState::Working {
            // The next settle could end the current turn, not this prompt's.
            return Err(Error::Conflict(
                "the agent is busy; wait for it first, or submit without waiting to queue the prompt"
                    .into(),
            ));
        }
        // Subscribed with the check, so no earlier turn is seen as this one.
        (
            Some(status.clone()),
            pane.pty.input_tx.clone(),
            pane.pty.journal(),
            mgr.statuses().subscribe(),
        )
    };
    let bracketed =
        tokio::task::spawn_blocking(move || screen::capture(&journal, 0).bracketed_paste)
            .await
            .map_err(|e| Error::Failed(e.to_string()))?;
    let text = prompt.trim_end_matches(['\r', '\n']);
    let paste = if bracketed {
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
    } else if text.contains(['\r', '\n']) {
        return Err(Error::Conflict(
            "the pane doesn't accept pasted text, so a newline would submit early".into(),
        ));
    } else {
        text.to_owned()
    };
    if paste.len() > MAX_INPUT {
        return Err(Error::Invalid("prompt exceeds 64 KiB".into()));
    }

    let deadline = Instant::now() + timeout;
    input.send_wait(paste.into_bytes()).await?;
    tokio::time::sleep(SUBMIT_DELAY).await;
    input.send_wait(b"\r".to_vec()).await?;
    drop(submitting);
    if !wait {
        // Keeps waited prompts out until this turn starts. A prompt queued
        // while the agent works returns at once: the agent may fold it into
        // the current turn.
        let state = state.clone();
        tokio::spawn(async move {
            let _shared = shared;
            let start = Instant::now() + START_TIMEOUT;
            let _ = wait_until(&state, pane_id, status, &mut events, turn_started, start).await;
        });
        return Ok(None);
    }

    let start = deadline.min(Instant::now() + START_TIMEOUT);
    let mut outcome = wait_until(state, pane_id, status, &mut events, turn_started, start).await?;
    drop(exclusive);
    let started = !outcome.timed_out && outcome.status.is_some();
    if started {
        outcome = wait_until(
            state,
            pane_id,
            outcome.status,
            &mut events,
            |s| SETTLED.contains(s),
            deadline,
        )
        .await?;
    }
    // Hooks report before the agent finishes drawing.
    let screen = match settle_output(state, pane_id).await {
        Ok(()) => capture_pane(state, pane_id, 0, None).await,
        Err(error) => Err(error),
    };
    let screen = match screen {
        Ok(screen) => Some(screen),
        Err(Error::PaneNotFound(_)) => None,
        Err(error) => return Err(error),
    };
    Ok(Some(PromptOutcome {
        status: outcome.status,
        started,
        timed_out: outcome.timed_out,
        screen,
    }))
}

/// Waits until the pane's output pauses for `OUTPUT_QUIET`, at most
/// `OUTPUT_SETTLE`.
async fn settle_output(state: &AppState, pane_id: Uuid) -> Result<(), Error> {
    let mut output = state
        .read()
        .await
        .find_pane(pane_id)
        .ok_or(Error::PaneNotFound(pane_id))?
        .pty
        .subscribe_output();
    let deadline = Instant::now() + OUTPUT_SETTLE;
    loop {
        tokio::select! {
            event = output.recv() => match event {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
            _ = tokio::time::sleep(OUTPUT_QUIET) => return Ok(()),
            _ = tokio::time::sleep_until(deadline) => return Ok(()),
        }
    }
}

/// Encodes tmux-style key names (`Enter`, `C-c`, `M-x`, `Up`, `F5`) as the
/// bytes a terminal sends, with cursor keys in `application` mode (DECCKM)
/// if set.
fn encode_keys<S: AsRef<str>>(keys: &[S], application: bool) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for key in keys {
        let key = key.as_ref();
        bytes.extend(encode_key(key, application).ok_or_else(|| format!("unknown key: {key}"))?);
    }
    Ok(bytes)
}

/// Whether `name` is a key name `send_keys` accepts, as opposed to text.
pub fn is_key(name: &str) -> bool {
    encode_key(name, false).is_some()
}

/// The final byte of a cursor key, which DECCKM changes.
fn cursor_key(key: &str) -> Option<u8> {
    let key = key.trim_start_matches("M-");
    Some(match key.to_ascii_lowercase().as_str() {
        "up" => b'A',
        "down" => b'B',
        "right" => b'C',
        "left" => b'D',
        "home" => b'H',
        "end" => b'F',
        _ => return None,
    })
}

fn encode_key(key: &str, application: bool) -> Option<Vec<u8>> {
    if let Some(rest) = key.strip_prefix("M-") {
        let mut bytes = vec![0x1b];
        bytes.extend(encode_key(rest, application)?);
        return Some(bytes);
    }
    if let Some(rest) = key.strip_prefix("C-") {
        return control(rest).map(|byte| vec![byte]);
    }
    if let Some(byte) = cursor_key(key) {
        return Some(vec![0x1b, if application { b'O' } else { b'[' }, byte]);
    }
    let named: &[u8] = match key.to_ascii_lowercase().as_str() {
        "enter" => b"\r",
        "tab" => b"\t",
        "btab" => b"\x1b[Z",
        "escape" | "esc" => b"\x1b",
        "space" => b" ",
        "bspace" | "backspace" => b"\x7f",
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
    use crate::pty::screen::MAX_CAPTURE_HISTORY;
    use crate::session::manager::SessionManager;
    use crate::ws::control::broadcast_state;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    async fn pane() -> (AppState, Uuid) {
        let (exit_tx, _) = mpsc::unbounded_channel();
        let (meta_tx, _) = mpsc::unbounded_channel();
        let mut mgr = SessionManager::new(
            if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
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

    // These type POSIX shell commands.
    #[cfg(unix)]
    #[tokio::test]
    async fn send_prompt_waits_for_the_turn() {
        let (state, pane_id) = pane().await;
        let error = send_prompt(&state, pane_id, "hi", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("no agent")));
        set(&state, pane_id, AgentState::Blocked).await;
        let error = send_prompt(&state, pane_id, "hi", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("decision")));
        set(&state, pane_id, AgentState::Working).await;
        let error = send_prompt(&state, pane_id, "hi", true, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("busy")));
        set(&state, pane_id, AgentState::Idle).await;
        // /bin/sh doesn't enable bracketed paste.
        let error = send_prompt(&state, pane_id, "a\nb", false, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("newline")));

        let prompt = tokio::spawn({
            let state = state.clone();
            async move { send_prompt(&state, pane_id, "echo btmux-$((6*7))", true, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(SUBMIT_DELAY * 2).await;
        set(&state, pane_id, AgentState::Working).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        set(&state, pane_id, AgentState::Idle).await;
        let outcome = prompt.await.unwrap().ok().unwrap().unwrap();
        assert!(outcome.started);
        assert!(!outcome.timed_out);
        assert_eq!(outcome.status.unwrap().state, AgentState::Idle);
        let screen = capture_pane(&state, pane_id, MAX_CAPTURE_HISTORY, None)
            .await
            .ok()
            .unwrap();
        assert!(screen.contains("btmux-42"), "{screen}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_prompt_sees_brief_turns_and_exits() {
        let (state, pane_id) = pane().await;
        set(&state, pane_id, AgentState::Idle).await;
        let prompt = tokio::spawn({
            let state = state.clone();
            async move { send_prompt(&state, pane_id, "true", true, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(SUBMIT_DELAY / 2).await;
        {
            // The whole turn passes before the waiter rereads.
            let mut mgr = state.write().await;
            for agent_state in [AgentState::Working, AgentState::Done] {
                mgr.set_agent_status(
                    pane_id,
                    AgentStatus {
                        state: agent_state,
                        ..AgentStatus::default()
                    },
                );
                broadcast_state(&mgr);
            }
        }
        let outcome = prompt.await.unwrap().ok().unwrap().unwrap();
        assert!(outcome.started);
        assert!(!outcome.timed_out);
        assert_eq!(outcome.status.unwrap().state, AgentState::Done);

        let prompt = tokio::spawn({
            let state = state.clone();
            async move { send_prompt(&state, pane_id, "true", true, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(SUBMIT_DELAY / 2).await;
        set(&state, pane_id, AgentState::Unknown).await;
        let outcome = tokio::time::timeout(Duration::from_secs(5), prompt)
            .await
            .unwrap()
            .unwrap()
            .ok()
            .unwrap()
            .unwrap();
        assert!(!outcome.started);
        assert!(!outcome.timed_out);
        assert!(outcome.status.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_prompts_stay_whole() {
        let (state, pane_id) = pane().await;
        set(&state, pane_id, AgentState::Idle).await;
        let send = |prompt: &'static str, wait| {
            let state = state.clone();
            tokio::spawn(
                async move { send_prompt(&state, pane_id, prompt, wait, DEFAULT_WAIT).await },
            )
        };
        let (left, right) = (send("echo LEFT", false), send("echo RIGHT", false));
        assert!(left.await.unwrap().ok().unwrap().is_none());
        assert!(right.await.unwrap().ok().unwrap().is_none());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let screen = capture_pane(&state, pane_id, MAX_CAPTURE_HISTORY, None)
                .await
                .ok()
                .unwrap();
            if screen.lines().any(|l| l == "LEFT") && screen.lines().any(|l| l == "RIGHT") {
                break;
            }
            assert!(Instant::now() < deadline, "{screen}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // A waited prompt can't claim an unwaited one's turn.
        let waited = send("true", true);
        tokio::time::sleep(SUBMIT_DELAY * 2).await;
        assert!(!waited.is_finished());
        set(&state, pane_id, AgentState::Working).await;
        let error = waited.await.unwrap();
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("busy")));
        set(&state, pane_id, AgentState::Idle).await;

        // Nor a second waited prompt the first one's.
        let first = send("true", true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = send("true", true);
        tokio::time::sleep(SUBMIT_DELAY * 2).await;
        set(&state, pane_id, AgentState::Working).await;
        let error = second.await.unwrap();
        assert!(matches!(error, Err(Error::Conflict(message)) if message.contains("busy")));
        set(&state, pane_id, AgentState::Idle).await;
        assert!(first.await.unwrap().ok().unwrap().unwrap().started);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_keys_checks_input_and_cursor_mode() {
        let (state, pane_id) = pane().await;
        let error = send_keys::<&str>(&state, pane_id, "", &[], None).await;
        assert!(matches!(error, Err(Error::Invalid(_))));
        let error = send_keys(&state, pane_id, "", &["Entr"], None).await;
        assert!(matches!(error, Err(Error::Invalid(_))));
        let error = send_keys(
            &state,
            pane_id,
            &"x".repeat(MAX_INPUT + 1),
            &["Enter"],
            None,
        )
        .await;
        assert!(matches!(error, Err(Error::Invalid(_))));
        let error = send_keys(&state, Uuid::new_v4(), "x", &["Up"], None).await;
        assert!(matches!(error, Err(Error::PaneNotFound(_))));
        let spawned = send_keys(
            &state,
            pane_id,
            "printf '\\033[?1h'",
            &["Enter", "Up"],
            None,
        )
        .await
        .ok()
        .unwrap();
        assert!(!spawned);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_closed_pane_is_an_exit() {
        let (state, pane_id) = pane().await;
        set(&state, pane_id, AgentState::Idle).await;
        let prompt = tokio::spawn({
            let state = state.clone();
            async move { send_prompt(&state, pane_id, "true", true, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(SUBMIT_DELAY * 2).await;
        set(&state, pane_id, AgentState::Working).await;
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { wait_for_agent(&state, pane_id, &SETTLED, DEFAULT_WAIT).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        {
            let mut mgr = state.write().await;
            mgr.handle_pane_exit(pane_id).await;
            broadcast_state(&mgr);
        }
        let outcome = waiter.await.unwrap().ok().unwrap();
        assert!(outcome.status.is_none() && !outcome.timed_out);
        let outcome = prompt.await.unwrap().ok().unwrap().unwrap();
        assert!(outcome.started && outcome.status.is_none() && outcome.screen.is_none());
        let error = wait_for_agent(&state, pane_id, &SETTLED, DEFAULT_WAIT).await;
        assert!(matches!(error, Err(Error::PaneNotFound(_))));
    }

    #[test]
    fn line_limit_counts_joined_lines() {
        let events = [
            Output::Size(4, 2),
            Output::Data(b"aaaaaaaa\r\nbbbbbbbb\r\ncccccccc\r\ndddddddd\r\n"[..].into()),
        ];
        assert_eq!(
            render(&events, MAX_CAPTURE_HISTORY, Some(3)),
            "bbbbbbbb\ncccccccc\ndddddddd\n"
        );
    }

    #[test]
    fn encodes_tmux_key_names() {
        assert_eq!(encode_keys(&["C-c"], false).unwrap(), b"\x03");
        assert_eq!(
            encode_keys(&["Enter", "M-x", "Up"], false).unwrap(),
            b"\r\x1bx\x1b[A"
        );
        assert_eq!(
            encode_keys(&["M-C-a", "C-Space", "q"], false).unwrap(),
            b"\x1b\x01\x00q"
        );
        assert_eq!(
            encode_keys(&["F5", "BTab"], false).unwrap(),
            b"\x1b[15~\x1b[Z"
        );
        assert_eq!(
            encode_keys(&["Up", "M-End", "PageUp"], true).unwrap(),
            b"\x1bOA\x1b\x1bOF\x1b[5~"
        );
        assert!(encode_keys(&["Entr"], false).is_err());
        assert!(encode_keys(&["C-é"], false).is_err());
    }

    #[test]
    fn parses_states_and_keeps_last_lines() {
        assert_eq!(
            parse_states(&["idle", "blocked"]).unwrap(),
            [AgentState::Idle, AgentState::Blocked]
        );
        assert_eq!(
            parse_states(&["done", " idle", ""]).unwrap(),
            [AgentState::Done, AgentState::Idle]
        );
        assert!(parse_states(&["asleep"]).is_err());
        assert!(parse_states::<&str>(&[]).is_err());
        assert!(parse_states(&[" "]).is_err());
        assert_eq!(last_lines("a\nb\nc\n", 2), "b\nc\n");
        assert_eq!(last_lines("a\n", 5), "a\n");
        assert_eq!(last_lines("a\n", 0), "");
    }
}
