use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::ClientConfig;
use crate::git;
use crate::session::layout::LayoutPreset;
use crate::session::manager::SessionSnapshot;
use crate::session::SessionSummary;
use crate::AppState;

pub async fn handle(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Build a `ServerMessage::State` snapshot from `mgr` and broadcast it to every
/// connected `/ws/control` socket. Every structural mutation — whether it came
/// in over the control socket or a REST endpoint — ends with this call so all
/// tabs re-render. Takes `&SessionManager` so it works under either a read or
/// write lock guard.
pub(crate) fn broadcast_state(mgr: &crate::session::manager::SessionManager) {
    let msg = ServerMessage::State {
        sessions: mgr.session_summaries(),
        all_sessions: mgr.all_snapshots(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
}

fn initial_messages(mgr: &crate::session::manager::SessionManager) -> [String; 2] {
    [
        serde_json::to_string(&ServerMessage::Config {
            config: Box::new(mgr.config().clone()),
        })
        .unwrap(),
        serde_json::to_string(&ServerMessage::State {
            sessions: mgr.session_summaries(),
            all_sessions: mgr.all_snapshots(),
        })
        .unwrap(),
    ]
}

async fn resynchronize(
    events: &mut tokio::sync::broadcast::Receiver<String>,
    state: &AppState,
) -> [String; 2] {
    let mgr = state.read().await;
    *events = mgr.events().subscribe();
    initial_messages(&mgr)
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    // Subscribe and snapshot under one guard; never hold it during socket I/O.
    let (mut events, initial) = {
        let mgr = state.read().await;
        (mgr.events().subscribe(), initial_messages(&mgr))
    };
    let (reply_tx, mut replies) = tokio::sync::mpsc::channel::<String>(32);
    let send = async {
        let mut pending = Vec::from(initial);
        loop {
            for json in pending.drain(..) {
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        ws_tx.send(Message::Text(json.into()))
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    return;
                }
            }
            let event = tokio::select! {
                reply = replies.recv() => { if let Some(reply) = reply { pending.push(reply); continue; } else { return; } },
                event = events.recv() => event,
            };
            match event {
                Ok(json) => pending.push(json),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    pending.extend(resynchronize(&mut events, &state).await);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    };
    let receive = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            let Message::Text(text) = msg else { continue };
            let value = serde_json::from_str::<serde_json::Value>(&text);
            let request_id = value
                .as_ref()
                .ok()
                .and_then(|v| v.get("request_id"))
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let result = match value.and_then(serde_json::from_value::<ClientMessage>) {
                Ok(cmd) => handle_command(cmd, &state).await,
                Err(error) => Err(format!("Invalid command: {error}")),
            };
            let reply = ServerMessage::CommandResult {
                request_id,
                error: result.err(),
            };
            if reply_tx
                .send(serde_json::to_string(&reply).unwrap())
                .await
                .is_err()
            {
                break;
            }
        }
    };
    // Cancelling either half drops the other, so failures cannot leave a socket
    // that still accepts commands but has stopped delivering state.
    tokio::select! { _ = send => {}, _ = receive => {} }
}

async fn handle_command(cmd: ClientMessage, state: &AppState) -> Result<(), String> {
    // Command-palette entries do their own locking (some need to release the
    // write lock to run blocking work), so they're handled before the generic
    // single-write-lock path below and broadcast their own state.
    if let ClientMessage::RunCommand {
        command,
        session_id,
    } = &cmd
    {
        return run_palette_command(command, *session_id, state).await;
    }

    if let ClientMessage::WritePaneInput { pane_id, text, .. } = &cmd {
        let mut mgr = state.write().await;
        let result = if let Some(pane) = mgr.find_pane(*pane_id) {
            pane.pty.input_tx.send(text.as_bytes().to_vec())
        } else {
            return Err("Pane no longer exists".into());
        };
        if result.is_ok() && mgr.note_agent_input(*pane_id) {
            broadcast_state(&mgr);
        }
        return result;
    }

    // Command-palette settings (color scheme, font, shader) are session-only:
    // they're layered over the on-disk config in memory and broadcast to every
    // tab, but config.toml is left untouched, so they last until btmux restarts
    // or the config file is reloaded.
    if let ClientMessage::UpdateConfig { update } = &cmd {
        let mut update = update.clone();
        if let Some(colors) = update.colors.as_deref() {
            if crate::config::is_color_scheme_url(colors) {
                match crate::config::load_remote_color_scheme(colors).await {
                    Ok(theme) => update.resolved_colors = Some(Box::new(theme)),
                    Err(error) => {
                        tracing::warn!("color scheme override failed: {error}");
                        return Err(format!("Color scheme error: {error}"));
                    }
                }
            }
        }
        let mut mgr = state.write().await;
        let config = mgr.apply_config_override(&update).clone();
        let json = serde_json::to_string(&ServerMessage::Config {
            config: Box::new(config),
        })
        .unwrap();
        let _ = mgr.events().send(json);
        return Ok(());
    }

    if let ClientMessage::ResetConfig = &cmd {
        let mut mgr = state.write().await;
        let config = mgr.reset_config_overrides().clone();
        let json = serde_json::to_string(&ServerMessage::Config {
            config: Box::new(config),
        })
        .unwrap();
        let _ = mgr.events().send(json);
        return Ok(());
    }

    let mut mgr = state.write().await;
    validate_command(&cmd, &mgr)?;
    match cmd {
        ClientMessage::Split {
            session_id,
            pane_id,
            direction,
        } => mgr.split_pane(session_id, pane_id, direction).await,
        ClientMessage::KillPane {
            session_id,
            pane_id,
        } => mgr.kill_pane(session_id, pane_id),
        ClientMessage::Navigate {
            session_id,
            direction,
        } => mgr.navigate(session_id, direction),
        ClientMessage::CreateWindow { session_id } => mgr.create_window(session_id).await,
        ClientMessage::SwitchWindow { session_id, index } => mgr.switch_window(session_id, index),
        ClientMessage::RenameWindow { session_id, name } => mgr.rename_window(session_id, name),
        ClientMessage::CloseWindow { session_id } => mgr.close_window(session_id),
        ClientMessage::KillWindow { window_id } => mgr.kill_window(window_id),
        ClientMessage::ZoomPane {
            session_id,
            pane_id,
        } => mgr.zoom_pane(session_id, pane_id),
        ClientMessage::LastWindow { session_id } => mgr.last_window(session_id),
        ClientMessage::LastPane { session_id } => mgr.last_pane(session_id),
        ClientMessage::SelectPane {
            session_id,
            pane_id,
        } => mgr.select_pane(session_id, pane_id),
        ClientMessage::AcknowledgeAgent { pane_id } => {
            mgr.acknowledge_agent(pane_id);
        }
        ClientMessage::CyclePane { session_id, delta } => mgr.cycle_pane(session_id, delta),
        ClientMessage::SwapPane { session_id, delta } => mgr.swap_pane(session_id, delta),
        ClientMessage::NextLayout { session_id } => mgr.next_layout(session_id),
        ClientMessage::CreateSession { name } => {
            mgr.create_session(name).await;
        }
        ClientMessage::RenameSession { session_id, name } => mgr.rename_session(session_id, name),
        ClientMessage::KillSession { id } => mgr.kill_session(id),
        ClientMessage::ResizeSplit {
            session_id,
            split_id,
            ratio,
        } => mgr.resize_split(session_id, split_id, ratio),
        ClientMessage::CapturePane { pane_id, content } => {
            mgr.capture_pane_to_editor(pane_id, content)
        }
        // Handled (and returned) above, before this write lock.
        ClientMessage::RunCommand { .. }
        | ClientMessage::UpdateConfig { .. }
        | ClientMessage::ResetConfig
        | ClientMessage::WritePaneInput { .. } => unreachable!(),
    }

    broadcast_state(&mgr);
    Ok(())
}

fn validate_command(
    cmd: &ClientMessage,
    mgr: &crate::session::manager::SessionManager,
) -> Result<(), String> {
    use ClientMessage::*;
    let session_id = match cmd {
        Split { session_id, .. }
        | KillPane { session_id, .. }
        | Navigate { session_id, .. }
        | CreateWindow { session_id }
        | SwitchWindow { session_id, .. }
        | RenameWindow { session_id, .. }
        | CloseWindow { session_id }
        | ZoomPane { session_id, .. }
        | LastWindow { session_id }
        | LastPane { session_id }
        | SelectPane { session_id, .. }
        | CyclePane { session_id, .. }
        | SwapPane { session_id, .. }
        | NextLayout { session_id }
        | RenameSession { session_id, .. }
        | ResizeSplit { session_id, .. } => Some(*session_id),
        KillSession { id } => Some(*id),
        _ => None,
    };
    let session = session_id
        .map(|id| {
            mgr.sessions
                .iter()
                .find(|s| s.id == id)
                .ok_or("Session no longer exists")
        })
        .transpose()?;
    let window = session.and_then(|s| s.windows.get(s.active_window));
    match cmd {
        KillSession { .. } if mgr.sessions.len() <= 1 => {
            return Err("Cannot kill the last session".into())
        }
        CloseWindow { .. } if session.is_some_and(|s| s.windows.len() <= 1) => {
            return Err("Cannot close the last window; kill the session instead".into())
        }
        Split { pane_id, .. }
        | KillPane { pane_id, .. }
        | ZoomPane { pane_id, .. }
        | SelectPane { pane_id, .. } => {
            if !window.is_some_and(|w| w.panes.iter().any(|p| p.id == *pane_id)) {
                return Err("Pane is no longer in the active window".into());
            }
            if matches!(cmd, KillPane { .. }) && window.is_some_and(|w| w.panes.len() <= 1) {
                return Err("Cannot kill the last pane; close the window instead".into());
            }
        }
        KillWindow { window_id }
            if !mgr
                .sessions
                .iter()
                .any(|s| s.windows.iter().any(|w| w.id == *window_id)) =>
        {
            return Err("Window no longer exists".into())
        }
        CapturePane { pane_id, .. } if mgr.find_pane(*pane_id).is_none() => {
            return Err("Pane no longer exists".into())
        }
        AcknowledgeAgent { pane_id } if mgr.find_pane(*pane_id).is_none() => {
            return Err("Pane no longer exists".into())
        }
        SwitchWindow { index, .. }
            if *index < -2
                || (*index >= 0
                    && !session.is_some_and(|s| (*index as usize) < s.windows.len())) =>
        {
            return Err("Window index is out of range".into())
        }
        RenameSession { name, .. } | RenameWindow { name, .. } if name.trim().is_empty() => {
            return Err("Name cannot be empty".into())
        }
        ResizeSplit { ratio, .. } if !ratio.is_finite() || *ratio <= 0.0 || *ratio >= 1.0 => {
            return Err("Split ratio must be between 0 and 1".into())
        }
        _ => {}
    }
    if let Split { direction, .. } = cmd {
        if !matches!(direction.as_str(), "h" | "v") {
            return Err("Invalid split direction".into());
        }
    }
    if let Navigate { direction, .. } = cmd {
        if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
            return Err("Invalid navigation direction".into());
        }
    }
    Ok(())
}

/// Run a built-in command-palette entry (`prefix + :`). Unlike the structural
/// commands above, these may need to release the write lock mid-run, so each
/// manages its own locking and broadcasts the resulting state. Unknown ids are
/// returned as errors. The command registry the browser shows lives in `config::default_commands`.
async fn run_palette_command(
    command: &str,
    session_id: Uuid,
    state: &AppState,
) -> Result<(), String> {
    // `select-layout-<preset>` palette entries re-arrange the active window into
    // a named preset; the preset name is the part after the `select-layout-` prefix.
    if let Some(preset_name) = command.strip_prefix("select-layout-") {
        let Some(preset) = LayoutPreset::from_name(preset_name) else {
            tracing::warn!("unknown layout preset: {}", preset_name);
            return Err("Command could not be completed; check the server log".into());
        };
        let mut mgr = state.write().await;
        mgr.select_layout(session_id, preset);
        broadcast_state(&mgr);
        return Ok(());
    }

    match command {
        "clear-sessions" => {
            let mut mgr = state.write().await;
            mgr.clear_sessions().await;
        }
        "create-sessions-from-git-repos" => {
            // Resolve the base dir under the read lock, then drop it so the
            // blocking filesystem/`git` scan doesn't stall other tabs' control
            // channels. Re-acquire the write lock only to apply the result.
            let base_dir = {
                let mgr = state.read().await;
                mgr.active_pane_cwd(session_id)
            };
            let Some(base_dir) = base_dir else {
                return Err("Pane has no working directory".into());
            };
            let discovery =
                match tokio::task::spawn_blocking(move || git::discover(&base_dir)).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!("git repo discovery task failed: {}", e);
                        return Err("Command could not be completed; check the server log".into());
                    }
                };
            let mut mgr = state.write().await;
            match discovery {
                git::Discovery::InsideRepo(layout) => {
                    mgr.add_worktree_windows(session_id, layout).await;
                }
                git::Discovery::ChildRepos(layouts) => {
                    if layouts.is_empty() {
                        tracing::info!("no git repos found");
                        return Err("Command could not be completed; check the server log".into());
                    }
                    mgr.create_sessions_from_git_repos(layouts).await;
                }
            }
        }
        other => {
            tracing::warn!("unknown palette command: {}", other);
            return Err("Command could not be completed; check the server log".into());
        }
    }

    let mgr = state.read().await;
    broadcast_state(&mgr);
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub(crate) enum ClientMessage {
    Split {
        session_id: Uuid,
        pane_id: Uuid,
        direction: String,
    },
    KillPane {
        session_id: Uuid,
        pane_id: Uuid,
    },
    Navigate {
        session_id: Uuid,
        direction: String,
    },
    CreateWindow {
        session_id: Uuid,
    },
    SwitchWindow {
        session_id: Uuid,
        index: i32,
    },
    RenameWindow {
        session_id: Uuid,
        name: String,
    },
    CloseWindow {
        session_id: Uuid,
    },
    KillWindow {
        window_id: Uuid,
    },
    ZoomPane {
        session_id: Uuid,
        pane_id: Uuid,
    },
    LastWindow {
        session_id: Uuid,
    },
    LastPane {
        session_id: Uuid,
    },
    SelectPane {
        session_id: Uuid,
        pane_id: Uuid,
    },
    AcknowledgeAgent {
        pane_id: Uuid,
    },
    CyclePane {
        session_id: Uuid,
        delta: i32,
    },
    SwapPane {
        session_id: Uuid,
        delta: i32,
    },
    NextLayout {
        session_id: Uuid,
    },
    CreateSession {
        name: Option<String>,
    },
    RenameSession {
        session_id: Uuid,
        name: String,
    },
    KillSession {
        id: Uuid,
    },
    ResizeSplit {
        session_id: Uuid,
        split_id: Uuid,
        ratio: f32,
    },
    /// Open a pane's scrollback (clean text read from the browser's ghostty-web
    /// buffer) in `$EDITOR` inside that pane's own shell. Content is captured
    /// client-side because only the emulator holds the de-escaped, wrapped
    /// scrollback.
    CapturePane {
        pane_id: Uuid,
        content: String,
    },
    WritePaneInput {
        #[allow(dead_code)]
        session_id: Uuid,
        pane_id: Uuid,
        text: String,
    },
    RunCommand {
        command: String,
        session_id: Uuid,
    },
    UpdateConfig {
        update: Box<crate::config::ConfigUpdate>,
    },
    ResetConfig,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ServerMessage {
    CommandResult {
        request_id: Option<String>,
        error: Option<String>,
    },
    State {
        sessions: Vec<SessionSummary>,
        all_sessions: Vec<SessionSnapshot>,
    },
    Config {
        config: Box<ClientConfig>,
    },
    Toast {
        message: String,
        level: ToastLevel,
    },
    PaneNotification {
        pane_id: Uuid,
        event: String,
        level: NotificationLevel,
        title: Option<String>,
        body: Option<String>,
    },
    PaneNotificationClear {
        pane_id: Uuid,
    },
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ToastLevel {
    Info,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum NotificationLevel {
    Info,
    Attention,
    Success,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn lag_recovery_uses_current_state_then_continues_streaming() {
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut mgr = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8044,
        );
        let id = mgr.create_session(Some("before".into())).await;
        let mut events = mgr.events().subscribe();
        for _ in 0..100 {
            broadcast_state(&mgr);
        }
        mgr.rename_session(id, "latest".into());
        broadcast_state(&mgr);
        assert!(matches!(
            events.recv().await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
        ));
        let state = std::sync::Arc::new(tokio::sync::RwLock::new(mgr));
        let [config, snapshot] = resynchronize(&mut events, &state).await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&config).unwrap()["type"],
            "config"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&snapshot).unwrap()["sessions"][0]["name"],
            "latest"
        );
        let mgr = state.read().await;
        mgr.events().send("next".into()).unwrap();
        assert_eq!(events.recv().await.unwrap(), "next");
        assert!(validate_command(
            &ClientMessage::KillPane {
                session_id: id,
                pane_id: Uuid::new_v4()
            },
            &mgr
        )
        .is_err());
    }
}
