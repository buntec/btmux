use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::file_git;
use crate::file_search::{self, FileIndex};
use crate::fs_ops;

pub struct FilesState {
    pub file_index: Arc<FileIndex>,
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    id: String,
    #[serde(rename = "type")]
    msg_type: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ServerMessage {
    id: String,
    #[serde(rename = "type")]
    msg_type: String,
    payload: serde_json::Value,
}

pub async fn handle(
    ws: WebSocketUpgrade,
    State(state): State<Arc<FilesState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<FilesState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(64);

    // Writer task: drains the mpsc channel into the WebSocket
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader loop: spawns one task per message so dispatch runs concurrently
    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else {
            continue;
        };

        let request: ClientMessage = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                let err = ServerMessage {
                    id: String::new(),
                    msg_type: "error".to_string(),
                    payload: serde_json::json!({ "message": format!("Invalid message: {}", e) }),
                };
                let _ = tx.send(serde_json::to_string(&err).unwrap()).await;
                continue;
            }
        };

        let state = state.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let response = dispatch(&request, &state).await;
            let _ = tx.send(serde_json::to_string(&response).unwrap()).await;
        });
    }
}

async fn dispatch(request: &ClientMessage, state: &FilesState) -> ServerMessage {
    let id = request.id.clone();

    let root_str = request
        .payload
        .get("root")
        .and_then(|r| r.as_str())
        .unwrap_or(".");
    let root = std::path::PathBuf::from(root_str);

    match request.msg_type.as_str() {
        "list_dir" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(".");

            match fs_ops::list_dir(&root, path).await {
                Ok((entries, resolved_path)) => ServerMessage {
                    id,
                    msg_type: "list_dir_result".to_string(),
                    payload: serde_json::json!({
                        "path": resolved_path,
                        "entries": entries,
                    }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "read_file" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");

            match fs_ops::read_file(&root, path).await {
                Ok(content) => ServerMessage {
                    id,
                    msg_type: "read_file_result".to_string(),
                    payload: serde_json::to_value(content).unwrap(),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "get_metadata" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");

            match fs_ops::get_metadata(&root, path).await {
                Ok(metadata) => ServerMessage {
                    id,
                    msg_type: "metadata_result".to_string(),
                    payload: serde_json::to_value(metadata).unwrap(),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "list_tree" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let max_depth = request
                .payload
                .get("max_depth")
                .and_then(|d| d.as_u64())
                .unwrap_or(4) as usize;
            let max_items = request
                .payload
                .get("max_items")
                .and_then(|d| d.as_u64())
                .unwrap_or(15) as usize;

            match fs_ops::list_tree(&root, path, max_depth, max_items).await {
                Ok(tree) => ServerMessage {
                    id,
                    msg_type: "list_tree_result".to_string(),
                    payload: serde_json::to_value(tree).unwrap(),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "search_files" => {
            let query = request
                .payload
                .get("query")
                .and_then(|q| q.as_str())
                .unwrap_or("");
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let search_root = fs_ops::validate_path(&root, path).unwrap_or_else(|_| root.clone());

            match state.file_index.search(query, &search_root).await {
                Ok(results) => ServerMessage {
                    id,
                    msg_type: "search_files_result".to_string(),
                    payload: serde_json::json!({
                        "results": results,
                        "done": true,
                    }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "search_content" => {
            let query = request
                .payload
                .get("query")
                .and_then(|q| q.as_str())
                .unwrap_or("");
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let search_root = fs_ops::validate_path(&root, path).unwrap_or_else(|_| root.clone());

            match file_search::content_search(query, &search_root).await {
                Ok(results) => ServerMessage {
                    id,
                    msg_type: "search_content_result".to_string(),
                    payload: serde_json::json!({
                        "results": results,
                        "done": true,
                    }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "git_status" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let git_root = fs_ops::validate_path(&root, path).unwrap_or_else(|_| root.clone());

            match file_git::git_status(&git_root).await {
                Ok(result) => ServerMessage {
                    id,
                    msg_type: "git_status_result".to_string(),
                    payload: serde_json::to_value(result).unwrap(),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "git_diff" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let staged = request
                .payload
                .get("staged")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);
            let cwd = request
                .payload
                .get("cwd")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let git_root = fs_ops::validate_path(&root, cwd).unwrap_or_else(|_| root.clone());

            match file_git::git_diff_file(&git_root, path, staged).await {
                Ok(result) => ServerMessage {
                    id,
                    msg_type: "git_diff_result".to_string(),
                    payload: serde_json::to_value(result).unwrap(),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "git_stage" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let cwd = request
                .payload
                .get("cwd")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let status_root = fs_ops::validate_path(&root, cwd).unwrap_or_else(|_| root.clone());

            if let Err(e) = file_git::git_stage_file(&status_root, path).await {
                return error_response(id, &e);
            }
            match file_git::git_status(&status_root).await {
                Ok(status) => ServerMessage {
                    id,
                    msg_type: "git_stage_result".to_string(),
                    payload: serde_json::json!({ "status": status }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "git_unstage" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let cwd = request
                .payload
                .get("cwd")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let status_root = fs_ops::validate_path(&root, cwd).unwrap_or_else(|_| root.clone());

            if let Err(e) = file_git::git_unstage_file(&status_root, path).await {
                return error_response(id, &e);
            }
            match file_git::git_status(&status_root).await {
                Ok(status) => ServerMessage {
                    id,
                    msg_type: "git_unstage_result".to_string(),
                    payload: serde_json::json!({ "status": status }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "git_discard" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let cwd = request
                .payload
                .get("cwd")
                .and_then(|p| p.as_str())
                .unwrap_or(".");
            let status_root = fs_ops::validate_path(&root, cwd).unwrap_or_else(|_| root.clone());

            if let Err(e) = file_git::git_discard_file(&status_root, path).await {
                return error_response(id, &e);
            }
            match file_git::git_status(&status_root).await {
                Ok(status) => ServerMessage {
                    id,
                    msg_type: "git_discard_result".to_string(),
                    payload: serde_json::json!({ "status": status }),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "trash_file" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");

            match fs_ops::trash_file(&root, path).await {
                Ok(()) => ServerMessage {
                    id,
                    msg_type: "trash_file_result".to_string(),
                    payload: serde_json::json!({}),
                },
                Err(e) => error_response(id, &e),
            }
        }
        "delete_file" => {
            let path = request
                .payload
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");

            match fs_ops::delete_file(&root, path).await {
                Ok(()) => ServerMessage {
                    id,
                    msg_type: "delete_file_result".to_string(),
                    payload: serde_json::json!({}),
                },
                Err(e) => error_response(id, &e),
            }
        }
        _ => error_response(id, &format!("Unknown message type: {}", request.msg_type)),
    }
}

fn error_response(id: String, message: &str) -> ServerMessage {
    ServerMessage {
        id,
        msg_type: "error".to_string(),
        payload: serde_json::json!({ "message": message }),
    }
}
