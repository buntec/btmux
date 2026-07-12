mod pane_io;
mod panes;
mod sessions;
mod windows;

use axum::Router;
use uuid::Uuid;

use crate::session::manager::SessionManager;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(sessions::router())
        .merge(windows::router())
        .merge(panes::router())
        .merge(pane_io::router())
}

pub(crate) fn session_exists(mgr: &SessionManager, session_id: Uuid) -> bool {
    mgr.sessions.iter().any(|s| s.id == session_id)
}

/// `None` = session doesn't exist. `Some(false)` = session exists but
/// `pane_id` isn't in its *active* window. `Some(true)` = safe to call the
/// mutator. Structural pane mutators (`split_pane`, `kill_pane`, `zoom_pane`,
/// `select_pane`) only ever operate on `session.windows[session.active_window]`
/// and silently no-op for a pane outside it — this turns that into an
/// explicit 409 instead of a false-success response.
pub(crate) fn pane_in_active_window(mgr: &SessionManager, session_id: Uuid, pane_id: Uuid) -> Option<bool> {
    let session = mgr.sessions.iter().find(|s| s.id == session_id)?;
    let window = &session.windows[session.active_window];
    Some(window.panes.iter().any(|p| p.id == pane_id))
}
