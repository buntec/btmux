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

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let mut events = {
        let mgr = state.read().await;
        let events = mgr.events().subscribe();

        let config_msg = ServerMessage::Config {
            config: Box::new(mgr.config().clone()),
        };
        let _ = ws_tx
            .send(Message::Text(
                serde_json::to_string(&config_msg).unwrap().into(),
            ))
            .await;

        let state_msg = ServerMessage::State {
            sessions: mgr.session_summaries(),
            all_sessions: mgr.all_snapshots(),
        };
        let _ = ws_tx
            .send(Message::Text(
                serde_json::to_string(&state_msg).unwrap().into(),
            ))
            .await;

        events
    };

    let send_task = tokio::spawn(async move {
        while let Ok(json) = events.recv().await {
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(cmd) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };
        handle_command(cmd, &state).await;
    }

    send_task.abort();
}

async fn handle_command(cmd: ClientMessage, state: &AppState) {
    // Command-palette entries do their own locking (some need to release the
    // write lock to run blocking work), so they're handled before the generic
    // single-write-lock path below and broadcast their own state.
    if let ClientMessage::RunCommand {
        command,
        session_id,
    } = &cmd
    {
        run_palette_command(command, *session_id, state).await;
        return;
    }

    if let ClientMessage::UpdateConfig { update } = &cmd {
        if let Err(e) = crate::config::apply_config_update(update) {
            tracing::error!("config update failed: {}", e);
            let toast_json = serde_json::to_string(&ServerMessage::Toast {
                message: format!("Config update failed: {e}"),
                level: ToastLevel::Error,
            })
            .unwrap();
            let mgr = state.read().await;
            let _ = mgr.events().send(toast_json);
        }
        return;
    }

    let mut mgr = state.write().await;
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
        ClientMessage::RunCommand { .. } | ClientMessage::UpdateConfig { .. } => unreachable!(),
    }

    let msg = ServerMessage::State {
        sessions: mgr.session_summaries(),
        all_sessions: mgr.all_snapshots(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
}

/// Run a built-in command-palette entry (`prefix + :`). Unlike the structural
/// commands above, these may need to release the write lock mid-run, so each
/// manages its own locking and broadcasts the resulting state. Unknown ids are
/// ignored. The command registry the browser shows lives in `config::default_commands`.
async fn run_palette_command(command: &str, session_id: Uuid, state: &AppState) {
    // `select-layout-<preset>` palette entries re-arrange the active window into
    // a named preset; the preset name is the part after the `select-layout-` prefix.
    if let Some(preset_name) = command.strip_prefix("select-layout-") {
        let Some(preset) = LayoutPreset::from_name(preset_name) else {
            tracing::warn!("unknown layout preset: {}", preset_name);
            return;
        };
        let mut mgr = state.write().await;
        mgr.select_layout(session_id, preset);
        let msg = ServerMessage::State {
            sessions: mgr.session_summaries(),
            all_sessions: mgr.all_snapshots(),
        };
        let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
        return;
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
            let Some(base_dir) = base_dir else { return };
            let layouts =
                match tokio::task::spawn_blocking(move || git::discover_repo_layouts(&base_dir))
                    .await
                {
                    Ok(layouts) => layouts,
                    Err(e) => {
                        tracing::warn!("git repo discovery task failed: {}", e);
                        return;
                    }
                };
            if layouts.is_empty() {
                tracing::info!("no git repos found");
                return;
            }
            let mut mgr = state.write().await;
            mgr.create_sessions_from_git_repos(layouts).await;
        }
        other => {
            tracing::warn!("unknown palette command: {}", other);
            return;
        }
    }

    let mgr = state.read().await;
    let msg = ServerMessage::State {
        sessions: mgr.session_summaries(),
        all_sessions: mgr.all_snapshots(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
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
    RunCommand {
        command: String,
        session_id: Uuid,
    },
    UpdateConfig {
        update: crate::config::ConfigUpdate,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
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
pub enum ToastLevel {
    Info,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLevel {
    Info,
    Attention,
    Success,
    Error,
}
