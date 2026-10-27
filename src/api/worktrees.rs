use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;

use super::pane_io::error_response;
use crate::worktree;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/panes/{pane_id}/worktree",
        axum::routing::post(api_create_worktree).delete(api_remove_worktree),
    )
}

#[derive(Deserialize)]
struct CreateWorktreeRequest {
    branch: String,
    /// Make its window the active one. Default true.
    select: Option<bool>,
}

async fn api_create_worktree(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(body): Json<CreateWorktreeRequest>,
) -> Response {
    match worktree::create(&state, pane_id, &body.branch, body.select.unwrap_or(true)).await {
        Ok(created) => Json(created).into_response(),
        Err(error) => error_response(error),
    }
}

async fn api_remove_worktree(State(state): State<AppState>, Path(pane_id): Path<Uuid>) -> Response {
    match worktree::remove(&state, pane_id).await {
        Ok(removed) => Json(removed).into_response(),
        Err(error) => error_response(error),
    }
}
