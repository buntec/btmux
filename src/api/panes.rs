use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::session::layout::LayoutPreset;
use crate::ws;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/panes/{pane_id}/split",
            axum::routing::post(api_split_pane),
        )
        .route(
            "/api/sessions/{session_id}/panes/{pane_id}",
            axum::routing::delete(api_kill_pane),
        )
        .route(
            "/api/sessions/{session_id}/panes/{pane_id}/zoom",
            axum::routing::post(api_zoom_pane),
        )
        .route(
            "/api/sessions/{session_id}/panes/{pane_id}/select",
            axum::routing::post(api_select_pane),
        )
        .route(
            "/api/sessions/{session_id}/panes/navigate",
            axum::routing::post(api_navigate),
        )
        .route(
            "/api/sessions/{session_id}/panes/cycle",
            axum::routing::post(api_cycle_pane),
        )
        .route(
            "/api/sessions/{session_id}/panes/swap",
            axum::routing::post(api_swap_pane),
        )
        .route(
            "/api/sessions/{session_id}/layout",
            axum::routing::post(api_select_layout),
        )
        .route(
            "/api/sessions/{session_id}/layout/next",
            axum::routing::post(api_next_layout),
        )
        .route("/api/panes", axum::routing::get(api_list_panes))
        .route(
            "/api/panes/{pane_id}",
            axum::routing::delete(api_kill_pane_by_id),
        )
        .route(
            "/api/panes/{pane_id}/split",
            axum::routing::post(api_split_pane_by_id),
        )
        .route(
            "/api/panes/{pane_id}/select",
            axum::routing::post(api_select_pane_by_id),
        )
}

async fn api_list_panes(State(state): State<AppState>) -> Response {
    Json(state.read().await.pane_infos()).into_response()
}

#[derive(Deserialize)]
struct SplitPaneByIdRequest {
    /// Where the new pane goes: left, right, up, or down.
    direction: String,
    cwd: Option<String>,
    /// Make the new pane active. Default true.
    select: Option<bool>,
}

/// Splits a pane in any window, returning the new pane's ID.
async fn api_split_pane_by_id(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<SplitPaneByIdRequest>,
) -> Response {
    if !["left", "right", "up", "down"].contains(&body.direction.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            "direction must be left, right, up, or down",
        )
            .into_response();
    }
    let mut mgr = state.write().await;
    let cwd = body.cwd.map(std::path::PathBuf::from);
    let Some(new_pane_id) = mgr
        .split_pane(pane_id, &body.direction, cwd, body.select.unwrap_or(true))
        .await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    ws::control::broadcast_state(&mgr);

    Json(serde_json::json!({ "pane_id": new_pane_id })).into_response()
}

/// Kills a pane in any window; its last pane closes the window, and the last
/// window the session.
async fn api_kill_pane_by_id(State(state): State<AppState>, Path(pane_id): Path<Uuid>) -> Response {
    let mut mgr = state.write().await;
    if mgr.find_pane(pane_id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Err(error) = mgr.kill_pane_by_id(pane_id) {
        return (StatusCode::CONFLICT, error).into_response();
    }

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

/// Makes the pane active and its window the session's active window.
async fn api_select_pane_by_id(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
) -> Response {
    let mut mgr = state.write().await;
    if !mgr.select_pane_by_id(pane_id) {
        return StatusCode::NOT_FOUND.into_response();
    }

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

/// Resolves session-not-found (404) vs. pane-not-in-active-window (409) for
/// the pane-addressed endpoints below. `Ok(())` means it's safe to mutate.
fn check_pane(
    mgr: &crate::session::manager::SessionManager,
    session_id: Uuid,
    pane_id: Uuid,
) -> Result<(), StatusCode> {
    match super::pane_in_active_window(mgr, session_id, pane_id) {
        None => Err(StatusCode::NOT_FOUND),
        Some(false) => Err(StatusCode::CONFLICT),
        Some(true) => Ok(()),
    }
}

#[derive(Deserialize)]
struct SplitPaneRequest {
    direction: String,
}

async fn api_split_pane(
    State(state): State<AppState>,
    Path((session_id, pane_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<SplitPaneRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if let Err(status) = check_pane(&mgr, session_id, pane_id) {
        return status.into_response();
    }
    mgr.split_pane(pane_id, &body.direction, None, true).await;

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_kill_pane(
    State(state): State<AppState>,
    Path((session_id, pane_id)): Path<(Uuid, Uuid)>,
) -> Response {
    let mut mgr = state.write().await;
    if let Err(status) = check_pane(&mgr, session_id, pane_id) {
        return status.into_response();
    }
    mgr.kill_pane(session_id, pane_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_zoom_pane(
    State(state): State<AppState>,
    Path((session_id, pane_id)): Path<(Uuid, Uuid)>,
) -> Response {
    let mut mgr = state.write().await;
    if let Err(status) = check_pane(&mgr, session_id, pane_id) {
        return status.into_response();
    }
    mgr.zoom_pane(session_id, pane_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_select_pane(
    State(state): State<AppState>,
    Path((session_id, pane_id)): Path<(Uuid, Uuid)>,
) -> Response {
    let mut mgr = state.write().await;
    if let Err(status) = check_pane(&mgr, session_id, pane_id) {
        return status.into_response();
    }
    mgr.select_pane(session_id, pane_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct NavigateRequest {
    direction: String,
}

async fn api_navigate(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<NavigateRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.navigate(session_id, body.direction);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct DeltaRequest {
    delta: i32,
}

async fn api_cycle_pane(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<DeltaRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.cycle_pane(session_id, body.delta);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_swap_pane(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<DeltaRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.swap_pane(session_id, body.delta);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct SelectLayoutRequest {
    preset: String,
}

async fn api_select_layout(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<SelectLayoutRequest>,
) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(preset) = LayoutPreset::from_name(&body.preset) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    mgr.select_layout(session_id, preset);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}

async fn api_next_layout(State(state): State<AppState>, Path(session_id): Path<Uuid>) -> Response {
    let mut mgr = state.write().await;
    if !super::session_exists(&mgr, session_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    mgr.next_layout(session_id);

    ws::control::broadcast_state(&mgr);

    StatusCode::NO_CONTENT.into_response()
}
