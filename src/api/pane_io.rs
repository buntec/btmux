use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{automation, config, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/panes/{pane_id}/input",
            axum::routing::post(api_pane_input),
        )
        .route(
            "/api/panes/{pane_id}/output",
            axum::routing::get(api_pane_output),
        )
        .route(
            "/api/panes/{pane_id}/capture",
            axum::routing::get(api_pane_capture),
        )
        .route(
            "/api/panes/{pane_id}/prompt",
            axum::routing::post(api_pane_prompt),
        )
        .route(
            "/api/panes/{pane_id}/wait",
            axum::routing::get(api_pane_wait),
        )
        .route("/api/agents", axum::routing::get(api_agents))
}

#[derive(Deserialize)]
struct PaneInputRequest {
    /// Sent verbatim, before `keys`.
    #[serde(default)]
    text: String,
    /// tmux-style key names, e.g. `["Enter"]` or `["C-c"]`.
    #[serde(default)]
    keys: Vec<String>,
    /// Only used if the PTY hasn't been spawned yet (no browser has attached
    /// to this pane). Ignored once a shell is already running.
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Serialize)]
struct PaneInputResponse {
    /// True if this call caused the shell to spawn. Callers polling
    /// `/output` afterward should expect a short delay before the shell
    /// prints its first prompt.
    newly_spawned: bool,
}

async fn api_pane_input(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<PaneInputRequest>,
) -> Response {
    let mut bytes = body.text.into_bytes();
    match automation::encode_keys(&body.keys) {
        Ok(keys) => bytes.extend(keys),
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    }
    let mut mgr = state.write().await;
    let Some(pane) = mgr.find_pane_mut(pane_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let newly_spawned = !pane.pty.is_spawned();
    if let Err(error) = pane.pty.ensure_spawned(
        body.cols.unwrap_or(config::DEFAULT_PTY_COLS),
        body.rows.unwrap_or(config::DEFAULT_PTY_ROWS),
    ) {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = pane.pty.input_tx.send(bytes) {
        return (StatusCode::SERVICE_UNAVAILABLE, error).into_response();
    }

    Json(PaneInputResponse { newly_spawned }).into_response()
}

#[derive(Deserialize)]
struct PaneOutputQuery {
    cols: Option<u16>,
    rows: Option<u16>,
}

/// Returns the pane's current scrollback as raw PTY bytes — exactly what the
/// terminal emulator receives (ANSI escapes included). `/capture` renders it
/// as text.
async fn api_pane_output(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Query(query): Query<PaneOutputQuery>,
) -> Response {
    let mut mgr = state.write().await;
    let Some(pane) = mgr.find_pane_mut(pane_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Err(error) = pane.pty.ensure_spawned(
        query.cols.unwrap_or(config::DEFAULT_PTY_COLS),
        query.rows.unwrap_or(config::DEFAULT_PTY_ROWS),
    ) {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    let (_rx, scrollback) = pane.pty.subscribe_and_get_scrollback();

    (
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from(scrollback),
    )
        .into_response()
}

#[derive(Deserialize)]
struct PaneCaptureQuery {
    /// Include retained scrollback above the screen.
    #[serde(default)]
    scrollback: bool,
    /// Only the last N lines.
    lines: Option<usize>,
}

/// The pane as rendered plain text, like `tmux capture-pane -pJ`.
async fn api_pane_capture(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Query(query): Query<PaneCaptureQuery>,
) -> Response {
    match automation::capture_pane(&state, pane_id, query.scrollback, query.lines).await {
        Ok(text) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Deserialize)]
struct PanePromptRequest {
    prompt: String,
    #[serde(default = "default_true")]
    wait: bool,
    timeout_ms: Option<u64>,
}

fn default_true() -> bool {
    true
}

async fn api_pane_prompt(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<PanePromptRequest>,
) -> Response {
    match automation::send_prompt(
        &state,
        pane_id,
        &body.prompt,
        body.wait,
        automation::wait_duration(body.timeout_ms),
    )
    .await
    {
        Ok(outcome) => Json(outcome).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Deserialize)]
struct PaneWaitQuery {
    /// Comma-separated agent states; default `idle,done,blocked`.
    states: Option<String>,
    timeout_ms: Option<u64>,
}

/// Long-polls until the pane's agent reaches one of `states` or exits.
async fn api_pane_wait(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Query(query): Query<PaneWaitQuery>,
) -> Response {
    let states = match query.states {
        Some(names) => match automation::parse_states(&names.split(',').collect::<Vec<_>>()) {
            Ok(states) => states,
            Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
        },
        None => automation::SETTLED.to_vec(),
    };
    match automation::wait_for_agent(
        &state,
        pane_id,
        &states,
        automation::wait_duration(query.timeout_ms),
    )
    .await
    {
        Ok(outcome) => Json(outcome).into_response(),
        Err(error) => error_response(error),
    }
}

async fn api_agents(State(state): State<AppState>) -> Response {
    Json(state.read().await.agent_panes()).into_response()
}

fn error_response(error: automation::Error) -> Response {
    let status = match error {
        automation::Error::PaneNotFound(_) => StatusCode::NOT_FOUND,
        automation::Error::Failed(_) => StatusCode::CONFLICT,
    };
    (status, error.to_string()).into_response()
}
