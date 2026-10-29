//! Clipboard images pasted into a pane: the browser uploads them, and the
//! pane receives the saved file's path, which agents (Claude Code, Codex, …)
//! attach as an image.

use std::io::Write;
use std::sync::Mutex;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use uuid::Uuid;

use crate::shell::Dialect;
use crate::ws::nvim::PrivateDir;
use crate::AppState;

pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Removed on shutdown.
static DIR: Mutex<Option<PrivateDir>> = Mutex::new(None);

fn extension(content_type: &str) -> Option<&'static str> {
    let mime = content_type.split(';').next()?.trim();
    Some(match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return None,
    })
}

fn save(ext: &str, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let mut dir = DIR.lock().unwrap();
    if dir.as_ref().is_none_or(|d| !d.path().is_dir()) {
        *dir = Some(PrivateDir::new()?);
    }
    let name = format!("paste-{}.{ext}", Uuid::new_v4().simple());
    let path = dir.as_ref().unwrap().path().join(name);
    crate::discovery::create_private_file(&path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// `path` as the shell names it, quoted only if needed: agents attach a path
/// that parses as one shell word, and a bare one is the most widely accepted.
fn pasted_path(dialect: Dialect, path: &str) -> String {
    let path = dialect.path(path);
    let windows = matches!(dialect, Dialect::PowerShell | Dialect::Cmd);
    let bare = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c) || (windows && c == '\\'));
    if bare {
        path.into_owned()
    } else {
        dialect.quote(&path)
    }
}

/// `POST /api/panes/{id}/paste-image`: save the body (PNG, JPEG, GIF, or
/// WebP) and reply `{"path": …}`, as the pane's shell names it.
pub async fn api_paste_image(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let dialect = {
        let mgr = state.read().await;
        let Some(pane) = mgr.find_pane(pane_id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        pane.pty.dialect()
    };
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let Some(ext) = extension(content_type) else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "only PNG, JPEG, GIF, and WebP images can be pasted",
        )
            .into_response();
    };
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty image").into_response();
    }
    match tokio::task::spawn_blocking(move || save(ext, &body)).await {
        Ok(Ok(path)) => {
            let path = pasted_path(dialect, &path.to_string_lossy());
            Json(serde_json::json!({ "path": path })).into_response()
        }
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

pub fn shutdown() {
    DIR.lock().unwrap().take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_agent_image_types() {
        assert_eq!(extension("image/png"), Some("png"));
        assert_eq!(extension("IMAGE/JPEG; charset=binary"), Some("jpg"));
        assert_eq!(extension("image/webp"), Some("webp"));
        assert_eq!(extension("image/svg+xml"), None);
        assert_eq!(extension(""), None);
    }

    #[test]
    fn quotes_pasted_paths_only_if_needed() {
        let p = "/var/folders/x_y/T/btmux-1/paste-2.png";
        assert_eq!(pasted_path(Dialect::Posix, p), p);
        assert_eq!(
            pasted_path(Dialect::Posix, "/tmp/a b/paste.png"),
            "'/tmp/a b/paste.png'"
        );
        let win = r"C:\Users\Ann\AppData\Local\Temp\paste.png";
        assert_eq!(pasted_path(Dialect::PowerShell, win), win);
        assert_eq!(
            pasted_path(Dialect::Cmd, r"C:\Users\A B\paste.png"),
            r#""C:\Users\A B\paste.png""#
        );
    }
}
