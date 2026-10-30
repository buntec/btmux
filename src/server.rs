use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use uuid::Uuid;

use crate::file_search::FileIndex;
use crate::session::{
    agent::{AgentEvent, AgentProcess, AgentReport, ToolCall, ToolInput},
    AgentState, AgentStatus, PaneAlert,
};
use crate::ws;
use crate::AppState;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct Assets;

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ServerInfo {
    pub version: String,
    pub profile: Option<String>,
    pub config_file: Option<String>,
    pub state_file: Option<String>,
    pub token_file: Option<String>,
    pub token_source: String,
    pub listen_address: String,
    pub executable: Option<String>,
    /// Daily log files; `None` when file logging is off.
    pub log_files: Option<String>,
    /// Changes on every start, including an in-place upgrade.
    pub instance: String,
    /// Kept by an in-place upgrade.
    pub pid: u32,
}

pub fn info_routes(info: ServerInfo) -> Router {
    Router::new().route(
        "/api/info",
        get(move || {
            let mut info = serde_json::to_value(&info).unwrap();
            info["upgrade_error"] = crate::handoff::last_error().into();
            async move { Json(info) }
        }),
    )
}

pub fn create_app(state: AppState) -> Router {
    let files_state = Arc::new(ws::files::FilesState {
        file_index: Arc::new(FileIndex::new()),
    });

    Router::new()
        .route("/ws/pane/{pane_id}", get(ws::pane_io::handle))
        .route("/ws/control", get(ws::control::handle))
        .route("/ws/processes", get(ws::processes::handle))
        .route("/ws/sysstat", get(ws::sysstat::handle))
        .route("/ws/nvim", get(ws::nvim::handle))
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
        .route("/api/notify", axum::routing::post(api_notify))
        .route("/api/server/upgrade", axum::routing::post(api_upgrade))
        .route("/api/server/shutdown", axum::routing::post(api_shutdown))
        .route(
            "/api/panes/{pane_id}/notify",
            axum::routing::post(api_pane_notify)
                .delete(api_pane_notify_clear)
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route(
            "/api/panes/{pane_id}/paste-image",
            axum::routing::post(crate::paste_image::api_paste_image)
                .layer(DefaultBodyLimit::max(crate::paste_image::MAX_BYTES)),
        )
        .route(
            "/api/panes/{pane_id}/open-file-browser",
            axum::routing::post(api_open_file_browser),
        )
        .route(
            "/api/panes/{pane_id}/focus",
            axum::routing::post(api_focus_pane),
        )
        .route(
            "/api/panes/{pane_id}/open-editor",
            axum::routing::post(api_open_editor),
        )
        .route("/api/nvim/file", axum::routing::get(api_nvim_file))
        .route("/api/vscode", get(crate::vscode::status))
        .route("/api/update", get(crate::update_check::status))
        .route("/api/wallpaper/check", get(api_wallpaper_check))
        .route(
            "/api/vscode/license",
            axum::routing::post(crate::vscode::accept),
        )
        .route(
            "/api/panes/{pane_id}/editor-file",
            axum::routing::get(api_pane_editor_file),
        )
        .route(
            "/api/panes/{pane_id}/agent-status",
            axum::routing::get(api_pane_agent_diagnostics)
                .post(api_pane_agent_status)
                .delete(api_pane_agent_status_clear),
        )
        .route("/api/file", get(serve_raw_file))
        .route("/wallpaper", get(serve_wallpaper))
        .route(
            crate::vscode::BASE_PATH,
            axum::routing::any(crate::vscode::proxy),
        )
        .route("/vscode/", axum::routing::any(crate::vscode::proxy))
        .route("/vscode/{*path}", axum::routing::any(crate::vscode::proxy))
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
struct UpgradeRequest {
    executable: std::path::PathBuf,
}

async fn api_upgrade(
    State(state): State<AppState>,
    Json(request): Json<UpgradeRequest>,
) -> impl IntoResponse {
    use crate::handoff::Refusal;
    match crate::handoff::upgrade(state, request.executable).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(Refusal::Incompatible(error)) => (StatusCode::CONFLICT, error).into_response(),
        Err(Refusal::Busy(error)) => (StatusCode::LOCKED, error).into_response(),
    }
}

static SHUTDOWN: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

/// Resolves once a client asks the server to stop.
pub async fn shutdown_requested() {
    SHUTDOWN.notified().await;
}

async fn api_shutdown() -> StatusCode {
    tracing::info!("shutdown requested over the API");
    SHUTDOWN.notify_one();
    StatusCode::ACCEPTED
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
    pane_id: Uuid,
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
    let session = mgr.sessions.iter().find(|s| s.id == id).unwrap();
    let name = session.name.clone();
    let pane_id = session.windows[0].panes[0].id;

    ws::control::broadcast_state(&mgr);

    Json(CreateSessionResponse { id, name, pane_id })
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
    /// Make it the active window. Default true.
    select: Option<bool>,
}

#[derive(Serialize)]
struct CreateWindowResponse {
    session_id: Uuid,
    pane_id: Uuid,
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
    let Some(pane_id) = mgr
        .create_window_named(session_id, body.name, cwd, body.select.unwrap_or(true))
        .await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    ws::control::broadcast_state(&mgr);

    Json(CreateWindowResponse {
        session_id,
        pane_id,
    })
    .into_response()
}

#[derive(Deserialize)]
struct PaneNotifyRequest {
    /// Agent harness hook event name (e.g. "Stop", "AfterAgent").
    hook_event_name: Option<String>,
    /// Harness identity; shared by every event in one agent session.
    session_id: Option<String>,
    /// Turn identity, when the harness provides one.
    turn_id: Option<String>,
    /// Claude Code: shared by every event of one turn.
    prompt_id: Option<String>,
    tool_use_id: Option<String>,
    /// Explicit event field (custom callers).
    event: Option<String>,
    /// Severity level for UI treatment.
    level: Option<ws::control::NotificationLevel>,
    /// Explicit title (custom callers or Notification event).
    title: Option<String>,
    /// Explicit body (custom callers).
    body: Option<String>,
    /// Claude Code/Codex Stop and SubagentStop: last assistant message.
    last_assistant_message: Option<String>,
    /// Gemini CLI AfterAgent: final response.
    prompt_response: Option<String>,
    /// Notification event message.
    message: Option<String>,
    /// Gemini CLI Notification category.
    notification_type: Option<String>,
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
    /// Optional agent name for semantic status reporting.
    agent: Option<String>,
    /// Optional reporter identity for semantic status reporting. SessionStart
    /// hooks may use this field for their start reason instead.
    source: Option<String>,
}

impl PaneNotifyRequest {
    fn resolve_event(&self) -> String {
        self.hook_event_name
            .clone()
            .or_else(|| self.event.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// Explicit `title`/`body` override the event's defaults field by field.
    fn resolve_title_body(&self, event: &str) -> (Option<String>, Option<String>) {
        let (title, body) = self.event_title_body(event);
        (
            cap_text(self.title.clone().or(title), 200),
            cap_text(self.body.clone().or(body), 1000),
        )
    }

    fn event_title_body(&self, event: &str) -> (Option<String>, Option<String>) {
        match event {
            "Stop" => (
                Some("Done".to_string()),
                self.last_assistant_message
                    .as_ref()
                    .map(|m| truncate_msg(m, 200)),
            ),
            "AfterAgent" => (
                Some("Done".to_string()),
                self.prompt_response.as_ref().map(|m| truncate_msg(m, 200)),
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
                self.notification_type
                    .clone()
                    .or_else(|| Some("Notification".to_string())),
                self.message.clone(),
            ),
            _ => (None, None),
        }
    }

    fn agent_report(
        &self,
        event: &str,
        body: Option<&str>,
        process: Option<AgentProcess>,
    ) -> Option<AgentReport> {
        Some(AgentReport {
            event: infer_agent_event(event, self.notification_type.as_deref())?,
            session_id: clean_status_field(self.session_id.clone(), 128),
            turn_id: clean_status_field(self.turn_id.clone().or(self.prompt_id.clone()), 128),
            tool: self.tool(),
            process,
            agent: clean_status_field(self.agent.clone(), 48),
            source: clean_status_field(
                self.source
                    .clone()
                    .filter(|source| {
                        event != "SessionStart"
                            || !matches!(
                                source.as_str(),
                                "startup" | "resume" | "clear" | "compact"
                            )
                    })
                    .or_else(|| Some("hook".to_string())),
                64,
            ),
            message: body.and_then(|value| clean_status_field(Some(value.to_string()), 200)),
        })
    }
}

impl PaneNotifyRequest {
    /// Identifies a tool call across its permission and completion hooks.
    fn tool(&self) -> Option<ToolCall> {
        let input = self
            .tool_name
            .as_ref()
            .zip(self.tool_input.as_ref())
            .map(|(name, input)| ToolInput::new(truncate_msg(name, 64), input));
        let id = clean_status_field(self.tool_use_id.clone(), 128);
        (id.is_some() || input.is_some()).then_some(ToolCall { id, input })
    }

    /// Whether an earlier hook already announced this prompt. Claude Code sends
    /// both PermissionRequest and a permission Notification for one dialog, and
    /// an idle reminder after Stop.
    fn repeats_hook_state(
        &self,
        event: &str,
        before: Option<(AgentState, Option<ToolCall>)>,
    ) -> bool {
        let Some((state, blocked_tool)) = before else {
            return false;
        };
        match state {
            AgentState::Blocked => match event {
                "PermissionRequest" => match (self.tool(), blocked_tool) {
                    (Some(tool), Some(blocked)) => blocked.matches(&tool),
                    _ => true,
                },
                _ => {
                    infer_agent_event(event, self.notification_type.as_deref())
                        == Some(AgentEvent::PermissionRequest)
                }
            },
            AgentState::Done | AgentState::Idle => {
                event == "Notification"
                    && self
                        .notification_type
                        .as_deref()
                        .is_some_and(|kind| kind.eq_ignore_ascii_case("idle_prompt"))
            }
            _ => false,
        }
    }
}

/// Trims and caps caller text at `max` characters, keeping line breaks.
fn cap_text(value: Option<String>, max: usize) -> Option<String> {
    let value = value?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(match value.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &value[..end]),
        None => value.to_string(),
    })
}

fn truncate_msg(s: &str, max: usize) -> String {
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() <= max {
        first_line.to_string()
    } else {
        let end = first_line
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|i| *i <= max)
            .last()
            .unwrap_or(0);
        format!("{}…", &first_line[..end])
    }
}

async fn api_pane_notify(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PaneNotifyRequest>,
) -> Response {
    let event = body.resolve_event();
    let level = body.level.unwrap_or_else(|| infer_level(&event));
    let (title, notif_body) = body.resolve_title_body(&event);
    let process = (!matches!(
        event.as_str(),
        "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" | "AfterTool" | "SessionEnd"
    ))
    .then(|| hook_process(&headers))
    .flatten();
    let report = body.agent_report(&event, notif_body.as_deref(), process);
    let mut mgr = state.write().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let repeated = body.repeats_hook_state(&event, mgr.hook_agent_state(pane_id));
    if let Some(report) = report {
        match mgr.apply_agent_report(pane_id, report, Instant::now()) {
            None => return StatusCode::NO_CONTENT.into_response(),
            Some(true) => ws::control::broadcast_state(&mgr),
            Some(false) => {}
        }
    }
    if matches!(
        event.as_str(),
        "SessionStart"
            | "SessionEnd"
            | "UserPromptSubmit"
            | "BeforeAgent"
            | "BeforeModel"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "PermissionDenied"
            | "AfterTool"
            | "Interrupt"
    ) || repeated
    {
        return StatusCode::NO_CONTENT.into_response();
    }

    // Bodies can quote agent output, so they stay out of info-level logs.
    tracing::info!(
        pane_id = %pane_id,
        event = %event,
        title = title.as_deref().unwrap_or("-"),
        "hook notification"
    );
    tracing::debug!(pane_id = %pane_id, body = notif_body.as_deref().unwrap_or("-"), "hook notification body");

    if let Some(pane) = mgr.find_pane_mut(pane_id) {
        pane.notify(PaneAlert {
            level,
            title: title.clone(),
            body: notif_body.clone(),
        });
    }
    ws::control::broadcast_state(&mgr);
    let msg = ws::control::ServerMessage::PaneNotification {
        pane_id,
        event,
        level,
        title,
        body: notif_body,
        os_client: mgr.alert_client(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct NotifyRequest {
    level: Option<ws::control::NotificationLevel>,
    title: String,
    body: Option<String>,
}

/// Show a notification, not tied to a pane, in every client.
async fn api_notify(State(state): State<AppState>, Json(body): Json<NotifyRequest>) -> Response {
    let Some(title) = cap_text(Some(body.title), 200) else {
        return (StatusCode::UNPROCESSABLE_ENTITY, "title is empty").into_response();
    };
    let level = body.level.unwrap_or(ws::control::NotificationLevel::Info);
    tracing::info!(title = %title, "notification");
    let mgr = state.read().await;
    let msg = ws::control::ServerMessage::Notification {
        level,
        title,
        body: cap_text(body.body, 1000),
        os_client: mgr.alert_client(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
    StatusCode::NO_CONTENT.into_response()
}

fn hook_process(headers: &HeaderMap) -> Option<AgentProcess> {
    let pid = headers
        .get("x-btmux-agent-pid")?
        .to_str()
        .ok()?
        .parse::<u32>()
        .ok()?;
    if pid <= 1 {
        return None;
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    Some(AgentProcess {
        pid,
        start_time: system
            .process(Pid::from_u32(pid))
            .map_or(0, |process| process.start_time()),
    })
}

#[derive(Deserialize)]
struct OpenFileBrowserRequest {
    path: String,
    mode: Option<ws::control::FileBrowserMode>,
    focus_file: Option<String>,
}

/// Current file of the pane's foreground Neovim, or `{"path": null}`.
async fn api_pane_editor_file(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    if state.read().await.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = ws::control::pane_neovim_file(pane_id, &state).await;
    Json(serde_json::json!({ "path": path })).into_response()
}

/// Current file of the built-in Neovim, or `{"path": null}`.
async fn api_nvim_file() -> Response {
    Json(serde_json::json!({ "path": ws::nvim::current_file().await })).into_response()
}

async fn api_open_file_browser(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<OpenFileBrowserRequest>,
) -> Response {
    let mgr = state.read().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let msg = ws::control::ServerMessage::OpenFileBrowser {
        pane_id,
        path: body.path,
        mode: body.mode.unwrap_or(ws::control::FileBrowserMode::Files),
        focus_file: body.focus_file,
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct OpenEditorRequest {
    path: Option<String>,
    line: Option<u32>,
    /// Overrides the `editor` setting.
    editor: Option<crate::config::Editor>,
}

/// `btmux open-editor`: with `editor` (the request's, else the setting)
/// `neovim` or `vscode`, open `path` (if any) in that editor and show it over the pane's session in every tab.
/// Replies `{"opened": false}` when the caller should run `$EDITOR` instead.
async fn api_open_editor(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<OpenEditorRequest>,
) -> Response {
    let editor = {
        let mgr = state.read().await;
        if mgr.find_pane(pane_id).is_none() {
            return StatusCode::NOT_FOUND.into_response();
        }
        body.editor.unwrap_or(mgr.config().editor)
    };
    let msg = match editor {
        crate::config::Editor::Pane => {
            return Json(serde_json::json!({ "opened": false })).into_response();
        }
        crate::config::Editor::Neovim => {
            if let Some(path) = &body.path {
                if let Err(error) = ws::nvim::open(path, body.line).await {
                    return (StatusCode::BAD_GATEWAY, error).into_response();
                }
            }
            ws::control::ServerMessage::OpenNvim { pane_id }
        }
        crate::config::Editor::Vscode => {
            if let Some(path) = &body.path {
                crate::vscode::open(path, body.line);
            }
            ws::control::ServerMessage::OpenVscode { pane_id }
        }
    };
    let _ = state
        .read()
        .await
        .events()
        .send(serde_json::to_string(&msg).unwrap());

    Json(serde_json::json!({ "opened": true })).into_response()
}

/// Switch every connected browser tab to the pane's window and session.
async fn api_focus_pane(State(state): State<AppState>, Path(pane_id): Path<Uuid>) -> Response {
    let mgr = state.read().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let msg = ws::control::ServerMessage::FocusPane { pane_id };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());

    StatusCode::NO_CONTENT.into_response()
}

async fn api_pane_notify_clear(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    let mut mgr = state.write().await;
    let Some(pane) = mgr.find_pane_mut(pane_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if pane.unread.take().is_some() {
        ws::control::broadcast_state(&mgr);
    }

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct PaneAgentStatusRequest {
    state: AgentState,
    agent: Option<String>,
    source: Option<String>,
    message: Option<String>,
}

async fn api_pane_agent_diagnostics(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    let mgr = state.read().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    Json(mgr.agent_diagnostics(pane_id)).into_response()
}

async fn api_pane_agent_status(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<PaneAgentStatusRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    mgr.set_agent_status(
        pane_id,
        AgentStatus {
            state: body.state,
            agent: clean_status_field(body.agent, 48),
            source: clean_status_field(body.source, 64),
            message: clean_status_field(body.message, 200),
        },
    );
    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_pane_agent_status_clear(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    let mut mgr = state.write().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }

    mgr.set_agent_status(pane_id, AgentStatus::default());
    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

fn clean_status_field(value: Option<String>, max: usize) -> Option<String> {
    let value = value?;
    let value = value.trim();
    (!value.is_empty()).then(|| truncate_msg(value, max))
}

fn infer_agent_event(event: &str, notification_type: Option<&str>) -> Option<AgentEvent> {
    match event {
        "SessionStart" => Some(AgentEvent::SessionStart),
        "SessionEnd" => Some(AgentEvent::SessionEnd),
        "UserPromptSubmit" | "BeforeAgent" | "BeforeModel" => Some(AgentEvent::TurnStart),
        "PermissionRequest" => Some(AgentEvent::PermissionRequest),
        "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" | "AfterTool" => {
            Some(AgentEvent::ToolFinished)
        }
        "Stop" | "AfterAgent" | "StopFailure" => Some(AgentEvent::TurnFinished),
        "Interrupt" => Some(AgentEvent::Interrupt),
        "Notification"
            if notification_type.is_some_and(|value| {
                let value = value.to_ascii_lowercase();
                matches!(
                    value.as_str(),
                    "toolpermission"
                        | "permission_prompt"
                        | "approval_request"
                        | "approval_required"
                )
            }) =>
        {
            Some(AgentEvent::PermissionRequest)
        }
        _ => None,
    }
}

/// Map well-known agent-harness hook events to notification severity.
fn infer_level(event: &str) -> ws::control::NotificationLevel {
    match event {
        "Stop" | "AfterAgent" => ws::control::NotificationLevel::Attention,
        // SubagentStop is intermediate progress during a working run (agent
        // harnesses may spawn many subagents) — not a "come back" signal. It
        // updates the StatusBar dot but no longer pops an OS/toast notification.
        "SubagentStop" => ws::control::NotificationLevel::Info,
        "PermissionRequest" | "Notification" => ws::control::NotificationLevel::Attention,
        "StopFailure" => ws::control::NotificationLevel::Error,
        "TaskCompleted" => ws::control::NotificationLevel::Success,
        _ => ws::control::NotificationLevel::Info,
    }
}

#[cfg(test)]
mod pane_notification_tests {
    use super::*;

    #[tokio::test]
    async fn runtime_info_requires_authentication() {
        use axum::http::Request;
        use tower::ServiceExt;

        let token = "a".repeat(64);
        let auth = Arc::new(crate::auth::Auth::new(token.clone(), "127.0.0.1", 8004, &[]).unwrap());
        let app = info_routes(ServerInfo {
            version: crate::config::VERSION.into(),
            profile: Some("dev".into()),
            config_file: Some("/config/btmux/config.toml".into()),
            state_file: Some("/state/btmux/dev/state.json".into()),
            token_file: Some("/state/btmux/dev/state.token".into()),
            token_source: "token file".into(),
            listen_address: "127.0.0.1:8004".into(),
            executable: None,
            log_files: None,
            instance: "test".into(),
            pid: 0,
        })
        .layer(axum::middleware::from_fn_with_state(
            auth,
            crate::auth::protect,
        ));

        for authenticated in [false, true] {
            let mut request = Request::builder()
                .uri("/api/info")
                .header(header::HOST, "localhost:8004");
            if authenticated {
                request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            if !authenticated {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let info: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(info["profile"], "dev");
            assert_eq!(info["token_file"], "/state/btmux/dev/state.token");
            assert_eq!(info["version"], crate::config::VERSION);
            assert!(!String::from_utf8_lossy(&body).contains(&token));
        }
    }

    #[tokio::test]
    async fn agent_diagnostics_are_authenticated_and_keep_unknown_agents_present() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        manager.update_detected_agents(
            &[(
                pane,
                AgentProcess {
                    pid: 42,
                    start_time: 1,
                },
                "codex".into(),
            )],
            |_| true,
        );
        assert_eq!(manager.running_agent_panes(), vec![pane]);
        let state = Arc::new(tokio::sync::RwLock::new(manager));
        let token = "a".repeat(64);
        let auth = Arc::new(crate::auth::Auth::new(token.clone(), "127.0.0.1", 8004, &[]).unwrap());
        let app = create_app(state).layer(axum::middleware::from_fn_with_state(
            auth,
            crate::auth::protect,
        ));
        for authenticated in [false, true] {
            let mut request = Request::builder()
                .uri(format!("/api/panes/{pane}/agent-status"))
                .header(header::HOST, "localhost:8004");
            if authenticated {
                request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            if !authenticated {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let diagnostics: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(diagnostics["status"]["state"], "unknown");
            assert_eq!(diagnostics["process"]["pid"], 42);
            assert!(diagnostics["detection"].is_null());
        }
    }

    #[tokio::test]
    async fn focus_pane_broadcasts_and_rejects_unknown_panes() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let mut events = manager.events().subscribe();
        let app = create_app(Arc::new(tokio::sync::RwLock::new(manager)));
        let post = |id: Uuid| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/panes/{id}/focus"))
                .body(Body::empty())
                .unwrap()
        };

        let response = app.clone().oneshot(post(Uuid::new_v4())).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(events.try_recv().is_err());

        let response = app.oneshot(post(pane)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let event: serde_json::Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(event["type"], "focus_pane");
        assert_eq!(event["pane_id"], pane.to_string());
    }

    #[tokio::test]
    async fn paste_image_saves_a_private_file() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let app = create_app(Arc::new(tokio::sync::RwLock::new(manager)));
        let post = |id: Uuid, content_type: &str| {
            Request::post(format!("/api/panes/{id}/paste-image"))
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from("PNG"))
                .unwrap()
        };

        let response = app
            .clone()
            .oneshot(post(Uuid::new_v4(), "image/png"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = app
            .clone()
            .oneshot(post(pane, "image/svg+xml"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let response = app.oneshot(post(pane, "image/png")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&body).unwrap();
        // `/bin/sh` quotes Windows paths.
        let path = std::path::PathBuf::from(reply["path"].as_str().unwrap().trim_matches('\''));
        assert_eq!(path.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&path).unwrap(), b"PNG");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode();
            assert_eq!(mode(&path) & 0o777, 0o600);
            assert_eq!(mode(path.parent().unwrap()) & 0o777, 0o700);
        }
    }

    #[tokio::test]
    async fn shutdown_request_signals_the_server() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let app = create_app(Arc::new(tokio::sync::RwLock::new(manager)));
        let response = app
            .oneshot(
                Request::post("/api/server/shutdown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_requested())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn notify_broadcasts_to_every_client() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let mut events = manager.events().subscribe();
        let app = create_app(Arc::new(tokio::sync::RwLock::new(manager)));
        let post = |body: serde_json::Value| {
            Request::post("/api/notify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };

        let response = app
            .clone()
            .oneshot(post(serde_json::json!({"title": "  "})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(events.try_recv().is_err());

        let response = app
            .oneshot(post(
                serde_json::json!({"level": "attention", "title": "Build done", "body": "ok"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let event: serde_json::Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(event["type"], "notification");
        assert_eq!(event["level"], "attention");
        assert_eq!(event["title"], "Build done");
        assert_eq!(event["body"], "ok");
    }

    #[tokio::test]
    async fn repeated_permission_and_idle_hooks_notify_once() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let mut events = manager.events().subscribe();
        let app = create_app(Arc::new(tokio::sync::RwLock::new(manager)));
        let hooks = [
            (serde_json::json!({"hook_event_name": "SessionStart"}), None),
            (
                serde_json::json!({"hook_event_name": "UserPromptSubmit"}),
                None,
            ),
            (
                serde_json::json!({"hook_event_name": "PermissionRequest", "tool_use_id": "t1", "tool_name": "Bash"}),
                Some("Permission: Bash"),
            ),
            (
                serde_json::json!({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"}),
                None,
            ),
            (
                serde_json::json!({"hook_event_name": "PostToolUse", "tool_use_id": "t1"}),
                None,
            ),
            (
                serde_json::json!({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"}),
                Some("permission_prompt"),
            ),
            (
                serde_json::json!({"hook_event_name": "PermissionRequest", "tool_use_id": "t2", "tool_name": "Edit"}),
                None,
            ),
            (serde_json::json!({"hook_event_name": "Stop"}), Some("Done")),
            (
                serde_json::json!({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Claude is waiting for your input"}),
                None,
            ),
        ];
        for (mut hook, expected) in hooks {
            hook["session_id"] = "s".into();
            let response = app
                .clone()
                .oneshot(
                    Request::post(format!("/api/panes/{pane}/notify"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(hook.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let mut titles = Vec::new();
            while let Ok(event) = events.try_recv() {
                let event: serde_json::Value = serde_json::from_str(&event).unwrap();
                if event["type"] == "pane_notification" {
                    titles.push(event["title"].as_str().unwrap().to_string());
                }
            }
            assert_eq!(titles, expected.into_iter().collect::<Vec<_>>(), "{hook}");
        }
    }

    #[tokio::test]
    async fn claude_hooks_pair_turns_by_prompt_id_and_tools_by_input() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let state = Arc::new(tokio::sync::RwLock::new(manager));
        let app = create_app(state.clone());
        let bash = serde_json::json!({"command": "ls"});
        let read = serde_json::json!({"file_path": "a.txt"});
        let question = |text: &str| {
            serde_json::json!([{"question": text, "header": "Pick", "multiSelect": false,
                "options": [{"label": "A", "description": "a"}, {"label": "B", "description": "b"}]}])
        };
        let (questions, other_questions) = (question("Pick one?"), question("Pick two?"));
        let answers = serde_json::json!({"Pick one?": "A"});
        // Payload shapes from Claude Code 2.1.312: PermissionRequest has no tool_use_id.
        let hooks = [
            (
                serde_json::json!({"hook_event_name": "SessionStart"}),
                AgentState::Idle,
            ),
            (
                serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt_id": "p1"}),
                AgentState::Working,
            ),
            (
                serde_json::json!({"hook_event_name": "PermissionRequest", "prompt_id": "p1", "tool_name": "Bash", "tool_input": bash}),
                AgentState::Blocked,
            ),
            (
                serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt_id": "p1"}),
                AgentState::Blocked,
            ),
            (
                serde_json::json!({"hook_event_name": "PostToolUse", "prompt_id": "p1", "tool_name": "Read", "tool_input": read, "tool_use_id": "t1"}),
                AgentState::Blocked,
            ),
            (
                serde_json::json!({"hook_event_name": "PostToolUse", "prompt_id": "p1", "tool_name": "Bash", "tool_input": bash, "tool_use_id": "t2"}),
                AgentState::Working,
            ),
            (
                serde_json::json!({"hook_event_name": "Stop", "prompt_id": "p1"}),
                AgentState::Done,
            ),
            (
                serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt_id": "p1"}),
                AgentState::Done,
            ),
            (
                serde_json::json!({"hook_event_name": "PermissionRequest", "prompt_id": "p1", "tool_name": "Bash", "tool_input": bash}),
                AgentState::Done,
            ),
            (
                serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt_id": "p2"}),
                AgentState::Working,
            ),
            // Answering AskUserQuestion adds answers and annotations to its input.
            (
                serde_json::json!({"hook_event_name": "PermissionRequest", "prompt_id": "p2", "tool_name": "AskUserQuestion", "tool_input": {"questions": questions}}),
                AgentState::Blocked,
            ),
            (
                serde_json::json!({"hook_event_name": "PostToolUse", "prompt_id": "p2", "tool_name": "AskUserQuestion", "tool_input": {"questions": other_questions, "answers": answers}, "tool_use_id": "t3"}),
                AgentState::Blocked,
            ),
            (
                serde_json::json!({"hook_event_name": "PostToolUse", "prompt_id": "p2", "tool_name": "AskUserQuestion", "tool_input": {"questions": questions, "answers": answers, "annotations": {"Pick one?": {"notes": "n"}}}, "tool_use_id": "t4"}),
                AgentState::Working,
            ),
        ];
        for (mut hook, expected) in hooks {
            hook["session_id"] = "s".into();
            let response = app
                .clone()
                .oneshot(
                    Request::post(format!("/api/panes/{pane}/notify"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(hook.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let mgr = state.read().await;
            assert_eq!(mgr.agent_status(pane).unwrap().state, expected, "{hook}");
        }
    }

    #[tokio::test]
    async fn unread_notifications_keep_the_most_severe_until_viewed() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let state = Arc::new(tokio::sync::RwLock::new(manager));
        let app = create_app(state.clone());
        let send = |method: &str, body: serde_json::Value| {
            Request::builder()
                .method(method)
                .uri(format!("/api/panes/{pane}/notify"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let unread = || async {
            state.read().await.snapshot_by_id(session).unwrap().windows[0].panes[0]
                .unread
                .clone()
        };
        let notify = |level: &str, title: &str| {
            send(
                "POST",
                serde_json::json!({"event": "custom", "level": level, "title": title, "body": "details"}),
            )
        };

        app.clone()
            .oneshot(notify("attention", "Done"))
            .await
            .unwrap();
        app.clone()
            .oneshot(notify("info", "helper done"))
            .await
            .unwrap();
        assert_eq!(
            unread().await,
            Some(PaneAlert {
                level: ws::control::NotificationLevel::Attention,
                title: Some("Done".into()),
                body: Some("details".into()),
            })
        );
        app.clone()
            .oneshot(notify("error", "Failed"))
            .await
            .unwrap();
        assert_eq!(unread().await.unwrap().title.as_deref(), Some("Failed"));

        assert!(state.write().await.acknowledge_pane(pane));
        assert_eq!(unread().await, None);

        app.clone()
            .oneshot(notify("attention", "Done"))
            .await
            .unwrap();
        assert!(unread().await.is_some());
        let response = app
            .clone()
            .oneshot(send("DELETE", serde_json::json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(unread().await, None);
    }

    #[test]
    fn explicit_title_keeps_the_event_body() {
        let request: PaneNotifyRequest = serde_json::from_value(serde_json::json!({
            "hook_event_name": "Notification",
            "title": "Claude Code",
            "notification_type": "permission_prompt",
            "message": "Claude needs your permission to use Bash"
        }))
        .unwrap();
        assert_eq!(
            request.resolve_title_body("Notification"),
            (
                Some("Claude Code".to_string()),
                Some("Claude needs your permission to use Bash".to_string())
            )
        );

        let request: PaneNotifyRequest = serde_json::from_value(serde_json::json!({
            "hook_event_name": "Stop",
            "body": "custom body",
            "last_assistant_message": "ignored"
        }))
        .unwrap();
        assert_eq!(
            request.resolve_title_body("Stop"),
            (Some("Done".to_string()), Some("custom body".to_string()))
        );
    }

    #[test]
    fn caps_explicit_title_and_body() {
        let request: PaneNotifyRequest = serde_json::from_value(serde_json::json!({
            "event": "custom",
            "title": "t".repeat(500),
            "body": format!("first line\n{}", "b".repeat(2000)),
        }))
        .unwrap();
        let (title, body) = request.resolve_title_body("custom");
        assert_eq!(title, Some(format!("{}…", "t".repeat(200))));
        let body = body.unwrap();
        assert!(body.starts_with("first line\nbbb"));
        assert_eq!(body.chars().count(), 1001);
        assert_eq!(cap_text(Some("  ".into()), 10), None);
        assert_eq!(cap_text(Some("🙂🙂🙂".into()), 2), Some("🙂🙂…".into()));
    }

    #[test]
    fn truncates_unicode_at_a_character_boundary() {
        let text = format!("{}🙂more", "a".repeat(199));
        assert_eq!(truncate_msg(&text, 200), format!("{}…", "a".repeat(199)));
        assert_eq!(truncate_msg("你好世界", 5), "你…");
        assert_eq!(truncate_msg("🙂", 4), "🙂");
    }

    #[test]
    fn resolves_gemini_after_agent_payload() {
        let request: PaneNotifyRequest = serde_json::from_value(serde_json::json!({
            "hook_event_name": "AfterAgent",
            "prompt_response": "Finished the requested refactor.\nMore detail"
        }))
        .unwrap();

        assert_eq!(
            request.resolve_title_body("AfterAgent"),
            (
                Some("Done".to_string()),
                Some("Finished the requested refactor.".to_string())
            )
        );
        assert!(matches!(
            infer_level("AfterAgent"),
            ws::control::NotificationLevel::Attention
        ));
    }

    #[test]
    fn resolves_gemini_notification_payload() {
        let request: PaneNotifyRequest = serde_json::from_value(serde_json::json!({
            "hook_event_name": "Notification",
            "notification_type": "ToolPermission",
            "message": "Approval required"
        }))
        .unwrap();

        assert_eq!(
            request.resolve_title_body("Notification"),
            (
                Some("ToolPermission".to_string()),
                Some("Approval required".to_string())
            )
        );
    }

    #[test]
    fn infers_agent_lifecycle_events_from_hooks() {
        assert_eq!(
            infer_agent_event("UserPromptSubmit", None),
            Some(AgentEvent::TurnStart)
        );
        assert_eq!(
            infer_agent_event("PermissionRequest", None),
            Some(AgentEvent::PermissionRequest)
        );
        assert_eq!(
            infer_agent_event("Stop", None),
            Some(AgentEvent::TurnFinished)
        );
        assert_eq!(
            infer_agent_event("Notification", Some("ToolPermission")),
            Some(AgentEvent::PermissionRequest)
        );
        assert_eq!(infer_agent_event("Notification", Some("Progress")), None);
        assert_eq!(infer_agent_event("TaskCompleted", None), None);
        assert_eq!(
            infer_agent_event("PostToolUse", None),
            Some(AgentEvent::ToolFinished)
        );
    }
}

#[derive(Deserialize)]
struct RawFileQuery {
    path: String,
}

async fn serve_raw_file(
    Query(query): Query<RawFileQuery>,
    request: axum::extract::Request,
) -> Response {
    let Ok(canonical) = tokio::fs::canonicalize(&query.path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(metadata) = tokio::fs::metadata(&canonical).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !metadata.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(response) = tower_http::services::ServeFile::new(&canonical)
        .try_call(request)
        .await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = response.into_response();
    // Local HTML/SVG must not acquire the terminal application's origin and
    // credentials when opened directly. Media still streams, with Range support.
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        "sandbox; default-src 'none'; style-src 'unsafe-inline'"
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[derive(Deserialize)]
struct WallpaperQuery {
    source: String,
}

async fn api_wallpaper_check(
    Query(query): Query<WallpaperQuery>,
) -> Json<crate::wallpaper::WallpaperCheck> {
    Json(crate::wallpaper::check(&query.source).await)
}

async fn serve_wallpaper(Query(query): Query<WallpaperQuery>) -> Response {
    crate::wallpaper::serve(&query.source).await
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
