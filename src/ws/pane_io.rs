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

use crate::{config, AppState};

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
    let cols = params.cols.unwrap_or(config::DEFAULT_PTY_COLS);
    let rows = params.rows.unwrap_or(config::DEFAULT_PTY_ROWS);
    let mirror = is_truthy(&params.mirror);

    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, pane_id, cols, rows, mirror, state))
}

/// Serialize a size update for a mirror socket.
fn size_frame(cols: u16, rows: u16) -> String {
    format!(r#"{{"type":"size","cols":{cols},"rows":{rows}}}"#)
}

/// Tell a viewer whether its size drives the PTY.
fn owner_frame(owner: bool) -> Message {
    Message::Text(format!(r#"{{"type":"owner","owner":{owner}}}"#).into())
}

async fn handle_socket(
    socket: WebSocket,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
    mirror: bool,
    state: AppState,
) {
    use crate::pty::replay::Output;
    let viewer_id = Uuid::new_v4();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let attachment = {
        let mut mgr = state.write().await;
        mgr.find_pane_mut(pane_id).map(|pane| {
            pane.pty.ensure_spawned(cols, rows)?;
            if !mirror {
                pane.pty.attach_viewer(viewer_id, cols, rows);
            }
            let (rx, replay) = pane.pty.subscribe_replay();
            Ok::<_, String>((
                pane.pty.input_tx.clone(),
                rx,
                replay,
                pane.pty.subscribe_owner(),
            ))
        })
    };
    let (input_tx, mut output_rx, replay, mut owner_rx) = match attachment {
        Some(Ok(attachment)) => attachment,
        failure => {
            let error = failure
                .and_then(Result::err)
                .unwrap_or_else(|| "Pane no longer exists".into());
            tracing::warn!(%pane_id, %error, "pane attach failed");
            let frame = Message::Text(
                serde_json::json!({"type": "error", "message": error})
                    .to_string()
                    .into(),
            );
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), ws_tx.send(frame)).await;
            return;
        }
    };
    let is_owner = |owner: &Option<Uuid>| !mirror && *owner == Some(viewer_id);
    let send = async {
        let mut pending = replay;
        let mut replaying = true;
        let mut owner = is_owner(&owner_rx.borrow_and_update());
        if !mirror
            && !matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    ws_tx.send(owner_frame(owner))
                )
                .await,
                Ok(Ok(()))
            )
        {
            return;
        }
        loop {
            for event in pending.drain(..) {
                let frame = match event {
                    Output::Data(bytes) => Message::Binary(bytes),
                    Output::Size(cols, rows) => Message::Text(size_frame(cols, rows).into()),
                };
                if !matches!(
                    tokio::time::timeout(std::time::Duration::from_secs(10), ws_tx.send(frame))
                        .await,
                    Ok(Ok(()))
                ) {
                    return;
                }
            }
            if replaying {
                let ready = Message::Text(
                    serde_json::json!({"type": "ready", "pane_id": pane_id})
                        .to_string()
                        .into(),
                );
                if !matches!(
                    tokio::time::timeout(std::time::Duration::from_secs(10), ws_tx.send(ready))
                        .await,
                    Ok(Ok(()))
                ) {
                    return;
                }
                replaying = false;
            }
            tokio::select! {
                event = output_rx.recv() => match event {
                    Ok(event) => pending.push(event),
                    // Output is stateful: disconnect instead of silently continuing
                    // past missing bytes. The client reconnects to a fresh snapshot.
                    Err(_) => return,
                },
                changed = owner_rx.changed(), if !mirror => {
                    if changed.is_err() {
                        return;
                    }
                    let next = is_owner(&owner_rx.borrow_and_update());
                    if next != owner {
                        owner = next;
                        if !matches!(
                            tokio::time::timeout(std::time::Duration::from_secs(10), ws_tx.send(owner_frame(owner))).await,
                            Ok(Ok(()))
                        ) {
                            return;
                        }
                    }
                }
            }
        }
    };
    let receive = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            if mirror {
                continue;
            }
            match msg {
                Message::Binary(data) => {
                    if input_tx.send_wait(data.to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Text(text) => {
                    if let Ok(control) = serde_json::from_str::<ControlMsg>(&text) {
                        let mut mgr = state.write().await;
                        if let Some(pane) = mgr.find_pane_mut(pane_id) {
                            match control {
                                ControlMsg::Resize { cols, rows } => {
                                    pane.pty.resize_viewer(viewer_id, cols, rows)
                                }
                                ControlMsg::Claim => pane.pty.claim_viewer(viewer_id),
                            }
                        }
                    } else {
                        if input_tx.send_wait(text.as_bytes().to_vec()).await.is_err() {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
    };
    tokio::select! { _ = send => {}, _ = receive => {} }
    if !mirror {
        let mut mgr = state.write().await;
        if let Some(pane) = mgr.find_pane_mut(pane_id) {
            pane.pty.detach_viewer(viewer_id);
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlMsg {
    Resize {
        cols: u16,
        rows: u16,
    },
    /// User input in this viewer: make its size drive the PTY.
    Claim,
}
