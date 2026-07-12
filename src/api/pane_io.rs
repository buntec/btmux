use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

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
}

#[derive(Deserialize)]
struct PaneInputRequest {
    text: String,
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
    let mut mgr = state.write().await;
    let Some(pane) = mgr.find_pane_mut(pane_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let newly_spawned = !pane.pty.is_spawned();
    pane.pty
        .ensure_spawned(body.cols.unwrap_or(DEFAULT_COLS), body.rows.unwrap_or(DEFAULT_ROWS));
    let _ = pane.pty.input_tx.send(body.text.into_bytes());

    Json(PaneInputResponse { newly_spawned }).into_response()
}

#[derive(Deserialize)]
struct PaneOutputQuery {
    cols: Option<u16>,
    rows: Option<u16>,
}

/// Returns the pane's current scrollback as raw PTY bytes — exactly what the
/// terminal emulator receives (ANSI escapes included), not de-escaped plain
/// text. No server-side VT parser exists; callers that want clean text must
/// strip escape codes themselves.
async fn api_pane_output(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Query(query): Query<PaneOutputQuery>,
) -> Response {
    let mut mgr = state.write().await;
    let Some(pane) = mgr.find_pane_mut(pane_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    pane.pty
        .ensure_spawned(query.cols.unwrap_or(DEFAULT_COLS), query.rows.unwrap_or(DEFAULT_ROWS));
    let (_rx, scrollback) = pane.pty.subscribe_and_get_scrollback();

    ([(header::CONTENT_TYPE, "application/octet-stream")], Body::from(scrollback)).into_response()
}
