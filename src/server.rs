use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::file_search::FileIndex;
use crate::ws;
use crate::AppState;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct Assets;

pub fn create_app(state: AppState) -> Router {
    let files_state = Arc::new(ws::files::FilesState {
        file_index: Arc::new(FileIndex::new()),
    });

    Router::new()
        .route("/ws/pane/{pane_id}", get(ws::pane_io::handle))
        .route("/ws/control", get(ws::control::handle))
        .route("/ws/sysstat", get(ws::sysstat::handle))
        .route("/ws/files", get(ws::files::handle).with_state(files_state))
        .route(
            "/api/sessions",
            axum::routing::get(api_list_sessions)
                .post(api_create_session)
                .delete(api_clear_sessions),
        )
        .route(
            "/api/sessions/{session_id}/windows",
            axum::routing::post(api_create_window),
        )
        .route(
            "/api/panes/{pane_id}/notify",
            axum::routing::post(api_pane_notify).delete(api_pane_notify_clear),
        )
        .route("/api/file", get(serve_raw_file))
        .route("/wallpaper", get(serve_wallpaper))
        .merge(crate::api::router())
        .nest_service("/mcp", crate::mcp::mcp_service(state.clone()))
        .route("/", get(|| async { serve("index.html") }))
        .route(
            "/{*path}",
            get(|Path(path): Path<String>| async move { serve(&path) }),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    name: Option<String>,
    cwd: Option<String>,
    window_name: Option<String>,
}

#[derive(Serialize)]
struct CreateSessionResponse {
    id: Uuid,
    name: String,
}

async fn api_list_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let mgr = state.read().await;
    Json(mgr.session_summaries())
}

async fn api_create_session(
    State(state): State<AppState>,
    Json(body): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let cwd = body.cwd.map(std::path::PathBuf::from);
    let mut mgr = state.write().await;
    let id = mgr
        .create_session_with_cwd_and_window(body.name, cwd, body.window_name)
        .await;
    let name = mgr
        .sessions
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.name.clone())
        .unwrap_or_default();

    ws::control::broadcast_state(&mgr);

    Json(CreateSessionResponse { id, name })
}

/// Kill every session and reset to a single fresh default session. Destructive;
/// driven by the `clear-sessions` subcommand. Broadcasts the new state so every
/// connected tab re-renders, and the debounced state-saver persists the reset.
async fn api_clear_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let mut mgr = state.write().await;
    mgr.clear_sessions().await;

    ws::control::broadcast_state(&mgr);

    Json(mgr.session_summaries())
}

#[derive(Deserialize)]
struct CreateWindowRequest {
    name: Option<String>,
    cwd: Option<String>,
}

#[derive(Serialize)]
struct CreateWindowResponse {
    session_id: Uuid,
}

async fn api_create_window(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<CreateWindowRequest>,
) -> Response {
    let cwd = body.cwd.map(std::path::PathBuf::from);
    let mut mgr = state.write().await;
    if !mgr.sessions.iter().any(|s| s.id == session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.create_window_named(session_id, body.name, cwd).await;

    ws::control::broadcast_state(&mgr);

    Json(CreateWindowResponse { session_id }).into_response()
}

#[derive(Deserialize)]
struct PaneNotifyRequest {
    /// Claude Code hook event name (e.g. "Stop", "PermissionRequest").
    hook_event_name: Option<String>,
    /// Explicit event field (custom callers).
    event: Option<String>,
    /// Severity level for UI treatment.
    level: Option<ws::control::NotificationLevel>,
    /// Explicit title (custom callers or Notification event).
    title: Option<String>,
    /// Explicit body (custom callers).
    body: Option<String>,
    /// CC Stop/SubagentStop/StopFailure: last assistant message.
    last_assistant_message: Option<String>,
    /// CC Notification event message.
    message: Option<String>,
    /// CC TaskCompleted: task subject line.
    task_subject: Option<String>,
    /// CC TaskCompleted: task description.
    task_description: Option<String>,
    /// CC PermissionRequest: tool name.
    tool_name: Option<String>,
    /// CC PermissionRequest: tool input object.
    tool_input: Option<serde_json::Value>,
    /// CC StopFailure: error category.
    error: Option<String>,
    /// CC SubagentStop: agent type.
    agent_type: Option<String>,
}

impl PaneNotifyRequest {
    fn resolve_event(&self) -> String {
        self.hook_event_name
            .clone()
            .or_else(|| self.event.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn resolve_title_body(&self, event: &str) -> (Option<String>, Option<String>) {
        if self.title.is_some() || self.body.is_some() {
            return (self.title.clone(), self.body.clone());
        }
        match event {
            "Stop" => (
                Some("Done".to_string()),
                self.last_assistant_message
                    .as_ref()
                    .map(|m| truncate_msg(m, 200)),
            ),
            "SubagentStop" => {
                let agent = self.agent_type.as_deref().unwrap_or("agent");
                (
                    Some(format!("{agent} done")),
                    self.last_assistant_message
                        .as_ref()
                        .map(|m| truncate_msg(m, 200)),
                )
            }
            "StopFailure" => {
                let err = self.error.as_deref().unwrap_or("error");
                (
                    Some(format!("Failed: {err}")),
                    self.last_assistant_message
                        .as_ref()
                        .map(|m| truncate_msg(m, 200)),
                )
            }
            "TaskCompleted" => (
                self.task_subject
                    .clone()
                    .or_else(|| Some("Task done".to_string())),
                self.task_description.clone(),
            ),
            "PermissionRequest" => {
                let tool = self.tool_name.as_deref().unwrap_or("tool");
                let desc = self
                    .tool_input
                    .as_ref()
                    .and_then(|v| v.get("description").and_then(|d| d.as_str()))
                    .or_else(|| {
                        self.tool_input
                            .as_ref()
                            .and_then(|v| v.get("command").and_then(|c| c.as_str()))
                    })
                    .map(|s| truncate_msg(s, 200));
                (Some(format!("Permission: {tool}")), desc)
            }
            "Notification" => (
                self.title.clone(),
                self.message.clone().or_else(|| self.body.clone()),
            ),
            _ => (None, None),
        }
    }
}

fn truncate_msg(s: &str, max: usize) -> String {
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() <= max {
        first_line.to_string()
    } else {
        format!("{}…", &first_line[..max])
    }
}

async fn api_pane_notify(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<PaneNotifyRequest>,
) -> Response {
    let mgr = state.read().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let event = body.resolve_event();
    let level = body.level.unwrap_or_else(|| infer_level(&event));
    let (title, notif_body) = body.resolve_title_body(&event);

    tracing::info!(
        pane_id = %pane_id,
        event = %event,
        title = title.as_deref().unwrap_or("-"),
        body = notif_body.as_deref().unwrap_or("-"),
        "hook notification"
    );

    let msg = ws::control::ServerMessage::PaneNotification {
        pane_id,
        event,
        level,
        title,
        body: notif_body,
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());

    StatusCode::NO_CONTENT.into_response()
}

async fn api_pane_notify_clear(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    let mgr = state.read().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let msg = ws::control::ServerMessage::PaneNotificationClear { pane_id };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());

    StatusCode::NO_CONTENT.into_response()
}

/// Map well-known Claude Code hook events to notification severity.
fn infer_level(event: &str) -> ws::control::NotificationLevel {
    match event {
        "Stop" => ws::control::NotificationLevel::Attention,
        // SubagentStop is intermediate progress during a working run (CC spawns
        // many subagents) — not a "come back" signal. Keep it quiet: it still
        // updates the StatusBar dot but no longer pops an OS/toast notification.
        "SubagentStop" => ws::control::NotificationLevel::Info,
        "PermissionRequest" | "Notification" => ws::control::NotificationLevel::Attention,
        "StopFailure" => ws::control::NotificationLevel::Error,
        "TaskCompleted" => ws::control::NotificationLevel::Success,
        _ => ws::control::NotificationLevel::Info,
    }
}

#[derive(Deserialize)]
struct RawFileQuery {
    path: String,
}

async fn serve_raw_file(Query(query): Query<RawFileQuery>) -> Response {
    let path = std::path::Path::new(&query.path);
    let Ok(canonical) = path.canonicalize() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(data) = tokio::fs::read(&canonical).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        Body::from(data),
    )
        .into_response()
}

async fn serve_wallpaper(State(state): State<AppState>) -> Response {
    let mgr = state.read().await;
    let Some(path) = mgr.config().wallpaper_path.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(data) = tokio::fs::read(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        Body::from(data),
    )
        .into_response()
}

fn serve(path: &str) -> Response {
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                Body::from(file.data),
            )
                .into_response()
        }
        // Fall back to index.html for client-side routing
        None => match Assets::get("index.html") {
            Some(file) => {
                ([(header::CONTENT_TYPE, "text/html")], Body::from(file.data)).into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
    }
}
