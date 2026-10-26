use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ws;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/windows/switch",
            axum::routing::post(api_switch_window),
        )
        .route(
            "/api/sessions/{session_id}/windows/rename",
            axum::routing::post(api_rename_window),
        )
        .route(
            "/api/sessions/{session_id}/windows/close",
            axum::routing::post(api_close_window),
        )
        .route(
            "/api/windows/{window_id}",
            axum::routing::delete(api_kill_window),
        )
        .route(
            "/api/windows/{window_id}/select",
            axum::routing::post(api_select_window_by_id),
        )
        .route(
            "/api/windows/{window_id}/rename",
            axum::routing::post(api_rename_window_by_id),
        )
}

async fn api_select_window_by_id(
    State(state): State<AppState>,
    Path(window_id): Path<Uuid>,
) -> Response {
    let mut mgr = state.write().await;
    if !mgr.select_window_by_id(window_id) {
        return StatusCode::NOT_FOUND.into_response();
    }

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_rename_window_by_id(
    State(state): State<AppState>,
    Path(window_id): Path<Uuid>,
    Json(body): Json<RenameWindowRequest>,
) -> Response {
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "name cannot be empty").into_response();
    }
    let mut mgr = state.write().await;
    mgr.rename_window_by_id(window_id, body.name);
    let Some(name) = mgr
        .sessions
        .iter()
        .flat_map(|s| &s.windows)
        .find(|w| w.id == window_id)
        .map(|w| w.name.clone())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    ws::control::broadcast_state(&mgr);

    Json(RenameWindowResponse { name }).into_response()
}

#[derive(Deserialize)]
struct SwitchWindowRequest {
    /// Absolute window index, or the sentinels `-1` (next) / `-2` (prev) also
    /// used by the `/ws/control` protocol.
    index: i32,
}

async fn api_switch_window(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<SwitchWindowRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.switch_window(session_id, body.index);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct RenameWindowRequest {
    name: String,
}

#[derive(Serialize)]
struct RenameWindowResponse {
    name: String,
}

/// Renames the session's *active* window — `SessionManager` has no
/// window-id-addressable rename. Callers targeting a specific window must
/// `switch` to it first.
async fn api_rename_window(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<RenameWindowRequest>,
) -> Response {
    let mut mgr = state.write().await;
    let Some(session) = mgr.sessions.iter().find(|s| s.id == session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let active_window = session.active_window;
    mgr.rename_window(session_id, body.name);
    let name = mgr
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .unwrap()
        .windows[active_window]
        .name
        .clone();

    ws::control::broadcast_state(&mgr);

    Json(RenameWindowResponse { name }).into_response()
}

/// Closes the session's *active* window — see `api_rename_window` note.
async fn api_close_window(State(state): State<AppState>, Path(session_id): Path<Uuid>) -> Response {
    let mut mgr = state.write().await;
    let Some(session) = mgr.sessions.iter().find(|s| s.id == session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if session.windows.len() <= 1 {
        return (StatusCode::CONFLICT, "cannot close the last window").into_response();
    }
    mgr.close_window(session_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_kill_window(State(state): State<AppState>, Path(window_id): Path<Uuid>) -> Response {
    let mut mgr = state.write().await;
    let Some(session) = mgr
        .sessions
        .iter()
        .find(|s| s.windows.iter().any(|w| w.id == window_id))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if session.windows.len() <= 1 {
        return (StatusCode::CONFLICT, "cannot kill the last window").into_response();
    }
    mgr.kill_window(window_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}
