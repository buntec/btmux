//! `btmux pick`: a menu over the pane, whose choice answers a CLI process
//! waiting on the request.

use std::io::{IsTerminal, Read, Write};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use uuid::Uuid;

use crate::session::manager::SessionManager;
use crate::ws::control::ServerMessage;
use crate::AppState;

pub const MAX_BYTES: usize = 16 * 1024 * 1024;

/// How long tabs have to report showing a pick.
#[cfg(not(test))]
const SHOW_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const SHOW_TIMEOUT: Duration = Duration::from_millis(100);

/// The request waits for the user, however long that takes.
const NO_TIMEOUT: Duration = Duration::from_secs(10 * 365 * 24 * 3600);

const EXIT_NOTHING_TO_PICK: i32 = 1;
const EXIT_FAILED: i32 = 2;
const EXIT_CANCELED: i32 = 130;

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PickItem {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PickRequest {
    pub prompt: Option<String>,
    pub items: Vec<PickItem>,
}

/// Tabs fetch the items only for a pane they show, so a long list isn't
/// broadcast.
#[derive(Serialize, Clone)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PickSummary {
    pub id: Uuid,
    pub pane_id: Uuid,
}

#[derive(Clone, Copy)]
enum Progress {
    Waiting,
    Shown,
    Answered(Option<usize>),
}

struct Pending {
    id: Uuid,
    pane_id: Uuid,
    request: Arc<PickRequest>,
    progress: watch::Sender<Progress>,
}

/// Open picks, in `SessionManager` so that connecting tabs get them.
#[derive(Default)]
pub struct Picks(Vec<Pending>);

impl Picks {
    pub fn summaries(&self) -> Vec<PickSummary> {
        self.0
            .iter()
            .map(|pick| PickSummary {
                id: pick.id,
                pane_id: pick.pane_id,
            })
            .collect()
    }

    pub fn shown(&self, id: Uuid) {
        if let Some(pick) = self.0.iter().find(|pick| pick.id == id) {
            pick.progress.send_if_modified(|progress| {
                let waiting = matches!(progress, Progress::Waiting);
                if waiting {
                    *progress = Progress::Shown;
                }
                waiting
            });
        }
    }

    /// The first answer wins, as several tabs can show one pick. `index` is
    /// an item, or `None` to cancel.
    pub fn answer(&self, id: Uuid, index: Option<usize>) {
        let Some(pick) = self.0.iter().find(|pick| pick.id == id) else {
            return;
        };
        if index.is_some_and(|index| index >= pick.request.items.len()) {
            return;
        }
        pick.progress.send_if_modified(|progress| {
            let open = !matches!(progress, Progress::Answered(_));
            if open {
                *progress = Progress::Answered(index);
            }
            open
        });
    }
}

fn broadcast(mgr: &SessionManager) {
    let msg = ServerMessage::Picks {
        picks: mgr.picks.summaries(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
}

/// Closes the pick however the request ends, including the CLI going away.
struct OpenPick {
    state: AppState,
    id: Uuid,
}

impl Drop for OpenPick {
    fn drop(&mut self) {
        let (state, id) = (self.state.clone(), self.id);
        tokio::spawn(async move {
            let mut mgr = state.write().await;
            mgr.picks.0.retain(|pick| pick.id != id);
            broadcast(&mgr);
        });
    }
}

/// Replies once the user answers: `{"index": n}`, or `null` if canceled.
pub async fn api_pick(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(request): Json<PickRequest>,
) -> Response {
    if request.items.is_empty() {
        return (StatusCode::BAD_REQUEST, "nothing to pick").into_response();
    }
    let id = Uuid::new_v4();
    let (progress, mut watcher) = watch::channel(Progress::Waiting);
    {
        let mut mgr = state.write().await;
        if mgr.find_pane(pane_id).is_none() {
            return StatusCode::NOT_FOUND.into_response();
        }
        if mgr.picks.0.iter().any(|pick| pick.pane_id == pane_id) {
            return (StatusCode::CONFLICT, "this pane already has a pick open").into_response();
        }
        mgr.picks.0.push(Pending {
            id,
            pane_id,
            request: Arc::new(request),
            progress,
        });
        broadcast(&mgr);
    }
    let _open = OpenPick {
        state: state.clone(),
        id,
    };
    let shown = tokio::time::timeout(
        SHOW_TIMEOUT,
        watcher.wait_for(|progress| !matches!(progress, Progress::Waiting)),
    )
    .await
    .is_ok_and(|shown| shown.is_ok());
    if !shown {
        return (StatusCode::CONFLICT, "no browser tab is showing this pane").into_response();
    }
    // Once shown, it stays open through tab reloads and window switches.
    let answer = match watcher
        .wait_for(|progress| matches!(progress, Progress::Answered(_)))
        .await
        .map(|progress| *progress)
    {
        Ok(Progress::Answered(index)) => index,
        _ => None,
    };
    Json(serde_json::json!({ "index": answer })).into_response()
}

pub async fn api_pick_items(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let request = {
        let mgr = state.read().await;
        let pick = mgr.picks.0.iter().find(|pick| pick.id == id);
        pick.map(|pick| pick.request.clone())
    };
    match request {
        Some(request) => Json(&*request).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Each line's output value (its raw bytes before any tab) and menu item.
fn parse_items(input: &[u8]) -> Vec<(&[u8], PickItem)> {
    input
        .split(|&byte| byte == b'\n')
        .filter_map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let tab = line.iter().position(|&byte| byte == b'\t');
            let value = &line[..tab.unwrap_or(line.len())];
            if value.is_empty() {
                return None;
            }
            let description = tab
                .map(|tab| String::from_utf8_lossy(&line[tab + 1..]).into_owned())
                .filter(|description| !description.is_empty());
            let label = String::from_utf8_lossy(value).into_owned();
            Some((value, PickItem { label, description }))
        })
        .collect()
}

/// Returns the exit code.
pub async fn run(prompt: Option<&str>) -> i32 {
    match pick(prompt).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("btmux: {error}");
            EXIT_FAILED
        }
    }
}

async fn pick(prompt: Option<&str>) -> Result<i32, String> {
    let pane = std::env::var("BTMUX_PANE_ID")
        .ok()
        .filter(|pane| !pane.is_empty())
        .ok_or("pick must run in a btmux pane")?;
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err("pick reads its items from stdin".into());
    }
    let mut input = Vec::new();
    stdin
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    let (values, items): (Vec<_>, Vec<_>) = parse_items(&input).into_iter().unzip();
    if items.is_empty() {
        return Ok(EXIT_NOTHING_TO_PICK);
    }
    let request = PickRequest {
        prompt: prompt.map(str::to_owned),
        items,
    };
    let body = serde_json::to_value(&request).map_err(|error| error.to_string())?;
    let reply = crate::api_client::request(
        None,
        reqwest::Method::POST,
        &format!("/api/panes/{pane}/pick"),
        Some(body),
        NO_TIMEOUT,
    )
    .await?;
    let reply: serde_json::Value =
        serde_json::from_str(&reply).map_err(|error| error.to_string())?;
    let Some(value) = reply["index"]
        .as_u64()
        .and_then(|index| values.get(index as usize))
    else {
        return Ok(EXIT_CANCELED);
    };
    // A reader that went away doesn't change what was picked.
    let mut stdout = std::io::stdout();
    let _ = stdout
        .write_all(value)
        .and_then(|()| stdout.write_all(b"\n"));
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, Router};
    use tower::ServiceExt;

    #[test]
    fn parses_values_and_descriptions() {
        let parsed = parse_items(b"plain\nwith\tA note\r\n\n\tno value\nempty\t\nbad\xff\tb\xffd");
        let values: Vec<_> = parsed.iter().map(|(value, _)| *value).collect();
        assert_eq!(
            values,
            [&b"plain"[..], b"with", b"empty", b"bad\xff"],
            "values keep their raw bytes"
        );
        let descriptions: Vec<_> = parsed
            .iter()
            .map(|(_, item)| item.description.as_deref())
            .collect();
        assert_eq!(
            descriptions,
            [None, Some("A note"), None, Some("b\u{fffd}d")]
        );
        assert_eq!(parsed[3].1.label, "bad\u{fffd}");
    }

    async fn app() -> (AppState, Router, Uuid) {
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let state: AppState = Arc::new(tokio::sync::RwLock::new(manager));
        (state.clone(), crate::server::create_app(state), pane)
    }

    fn open(app: &Router, pane: Uuid) -> tokio::task::JoinHandle<(StatusCode, serde_json::Value)> {
        let app = app.clone();
        tokio::spawn(async move {
            let body = r#"{"prompt":"p","items":[{"label":"a","description":null},{"label":"b","description":"note"}]}"#;
            let response = app
                .oneshot(
                    Request::post(format!("/api/panes/{pane}/pick"))
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), MAX_BYTES)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
            )
        })
    }

    async fn open_id(state: &AppState) -> Uuid {
        for _ in 0..200 {
            if let Some(pick) = state.read().await.picks.summaries().first() {
                return pick.id;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the pick never opened");
    }

    async fn closed(state: &AppState) {
        for _ in 0..200 {
            if state.read().await.picks.summaries().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the pick never closed");
    }

    #[tokio::test]
    async fn fails_when_no_tab_shows_it() {
        let (state, app, pane) = app().await;
        let (status, _) = open(&app, pane).await.unwrap();
        assert_eq!(status, StatusCode::CONFLICT);
        closed(&state).await;
    }

    #[tokio::test]
    async fn first_answer_wins_after_the_show_timeout() {
        let (state, app, pane) = app().await;
        let request = open(&app, pane);
        let id = open_id(&state).await;
        state.read().await.picks.shown(id);
        // Shown picks wait for the user.
        tokio::time::sleep(SHOW_TIMEOUT * 2).await;
        assert!(!request.is_finished());

        let items = app
            .clone()
            .oneshot(
                Request::get(format!("/api/picks/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let items = axum::body::to_bytes(items.into_body(), MAX_BYTES)
            .await
            .unwrap();
        let items: serde_json::Value = serde_json::from_slice(&items).unwrap();
        assert_eq!(items["prompt"], "p");
        assert_eq!(items["items"][1]["description"], "note");

        {
            let mgr = state.read().await;
            mgr.picks.answer(id, Some(99));
            mgr.picks.answer(id, Some(1));
            mgr.picks.answer(id, None);
        }
        let (status, reply) = request.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["index"], 1);
        closed(&state).await;
    }

    #[tokio::test]
    async fn a_pane_has_one_pick_and_cancel_replies_null() {
        let (state, app, pane) = app().await;
        let first = open(&app, pane);
        let id = open_id(&state).await;
        let (status, _) = open(&app, pane).await.unwrap();
        assert_eq!(status, StatusCode::CONFLICT);
        state.read().await.picks.answer(id, None);
        let (status, reply) = first.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(reply["index"].is_null());
    }

    #[tokio::test]
    async fn a_dropped_request_closes_the_pick() {
        let (state, app, pane) = app().await;
        let request = open(&app, pane);
        let id = open_id(&state).await;
        state.read().await.picks.shown(id);
        request.abort();
        closed(&state).await;
    }

    #[tokio::test]
    async fn rejects_unknown_panes_and_empty_lists() {
        let (_state, app, pane) = app().await;
        let (status, _) = open(&app, Uuid::new_v4()).await.unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND);
        let response = app
            .oneshot(
                Request::post(format!("/api/panes/{pane}/pick"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"prompt":null,"items":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
