use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;

#[derive(Deserialize)]
pub struct PaneParams {
    cols: Option<u16>,
    rows: Option<u16>,
    /// Read-only mirror attach for window-grid thumbnails. A mirror subscribes to
    /// the pane's output and scrollback but never resizes the PTY and ignores all
    /// input — so it can attach alongside the real viewer without reflowing the
    /// live shell or clearing its scrollback. The PTY's real size is pushed to the
    /// mirror via a `{"type":"size",...}` frame (initially and on every resize).
    ///
    /// Parsed as a string (not `bool`) so `?mirror=1` works too — `serde_urlencoded`
    /// only accepts `true`/`false` for `bool`, and a parse failure would reject the
    /// whole query and fail the WebSocket upgrade. `is_truthy` treats `1`/`true` as set.
    mirror: Option<String>,
}

/// Whether a query flag string means "enabled" (`1` or `true`, case-insensitive).
fn is_truthy(v: &Option<String>) -> bool {
    matches!(
        v.as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("True")
    )
}

pub async fn handle(
    Path(pane_id): Path<Uuid>,
    Query(params): Query<PaneParams>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let cols = params.cols.unwrap_or(80);
    let rows = params.rows.unwrap_or(24);
    let mirror = is_truthy(&params.mirror);

    ws.on_upgrade(move |socket| handle_socket(socket, pane_id, cols, rows, mirror, state))
}

/// Serialize a size update for a mirror socket.
fn size_frame(cols: u16, rows: u16) -> String {
    format!(r#"{{"type":"size","cols":{cols},"rows":{rows}}}"#)
}

async fn handle_socket(
    socket: WebSocket,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
    mirror: bool,
    state: AppState,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (input_tx, mut output_rx, mut size_rx, scrollback, pty_size, is_reconnect) = {
        let mut mgr = state.write().await;
        let Some(pane) = mgr.find_pane_mut(pane_id) else {
            let _ = ws_tx.close().await;
            return;
        };

        let was_spawned = pane.pty.is_spawned();
        // A mirror must spawn the shell if it's the first to attach (so a
        // never-viewed window still shows a live thumbnail) but must NOT resize:
        // resizing would reflow the real shell and clear its scrollback.
        pane.pty.ensure_spawned(cols, rows);
        if !mirror {
            // Resize first so the scrollback is cleared before we snapshot it — a
            // resize clears the buffer because old content was wrapped for the old
            // column width and would render as garbage at the new size.
            pane.pty.resize(cols, rows);
        }
        // Subscribe and snapshot atomically so no chunk can appear in both the
        // replay and the live stream (which would garble the display).
        let (output_rx, scrollback) = pane.pty.subscribe_and_get_scrollback();
        let size_rx = pane.pty.subscribe_size();
        let pty_size = pane.pty.size();

        tracing::debug!(pane_id=%pane_id, mirror, scrollback_bytes=scrollback.len(), "pane ws connect");

        (
            pane.pty.input_tx.clone(),
            output_rx,
            size_rx,
            scrollback,
            pty_size,
            was_spawned,
        )
    };

    // Tell a mirror the PTY's real size up front so it can fit its emulator to the
    // same grid the scrollback was wrapped for, then scale it down with CSS.
    if mirror {
        let (c, r) = pty_size;
        if ws_tx
            .send(Message::Text(size_frame(c, r).into()))
            .await
            .is_err()
        {
            return;
        }
    }

    // On reconnect, replay buffered output so client sees existing content
    if !scrollback.is_empty()
        && ws_tx
            .send(Message::Binary(scrollback.into()))
            .await
            .is_err()
    {
        return;
    }

    // If this is a reconnect to an already-running PTY, kick a SIGWINCH so TUI
    // apps redraw. The scrollback may contain a mid-draw cursor-hide
    // (\x1b[?25l) that the app never reversed — a SIGWINCH triggers a full
    // repaint and restores the correct cursor state. A mirror never resizes, so
    // it must not trigger SIGWINCH (which would disturb the real viewer's PTY).
    if is_reconnect && !mirror {
        let mgr = state.read().await;
        if let Some(pane) = mgr.find_pane(pane_id) {
            pane.pty.force_sigwinch();
        }
    }

    // PTY output -> WebSocket. A mirror also forwards size changes so the
    // thumbnail re-fits when a real viewer resizes the pane in the background.
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                out = output_rx.recv() => {
                    match out {
                        Ok(data) => {
                            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => break,
                    }
                }
                size = size_rx.recv(), if mirror => {
                    match size {
                        Ok((c, r)) => {
                            if ws_tx.send(Message::Text(size_frame(c, r).into())).await.is_err() {
                                break;
                            }
                        }
                        // Lagged: skip; the next output/size update keeps us close enough.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => break,
                    }
                }
            }
        }
    });

    // WebSocket -> PTY input. A mirror is read-only: drop everything except the
    // close so it can never type into or resize the shared PTY.
    while let Some(Ok(msg)) = ws_rx.next().await {
        if mirror {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        }
        match msg {
            Message::Binary(data) => {
                let _ = input_tx.send(data.to_vec());
            }
            Message::Text(text) => {
                if let Ok(resize) = serde_json::from_str::<ResizeMsg>(&text) {
                    if resize.r#type == "resize" {
                        let mgr = state.read().await;
                        if let Some(pane) = mgr.find_pane(pane_id) {
                            pane.pty.resize(resize.cols, resize.rows);
                        }
                    }
                } else {
                    let _ = input_tx.send(text.as_bytes().to_vec());
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
}

#[derive(Deserialize)]
struct ResizeMsg {
    r#type: String,
    cols: u16,
    rows: u16,
}
