//! `btmux pick`, `confirm`, and `input`: a widget over the pane, whose answer
//! goes to a CLI process waiting on the request.

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

/// How long tabs have to report showing a widget.
#[cfg(not(test))]
const SHOW_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const SHOW_TIMEOUT: Duration = Duration::from_millis(100);

/// The request waits for the user, however long that takes.
const NO_TIMEOUT: Duration = Duration::from_secs(10 * 365 * 24 * 3600);

const EXIT_NO: i32 = 1;
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
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum WidgetRequest {
    Pick {
        prompt: Option<String>,
        items: Vec<PickItem>,
        /// The filter's initial text.
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        multi: bool,
        /// Filtering keeps input order instead of ranking label prefixes first.
        #[serde(default)]
        no_sort: bool,
    },
    Confirm {
        message: String,
        default_yes: bool,
    },
    Input {
        prompt: Option<String>,
        default: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum WidgetKind {
    Pick,
    Confirm,
    Input,
}

impl WidgetRequest {
    fn kind(&self) -> WidgetKind {
        match self {
            Self::Pick { .. } => WidgetKind::Pick,
            Self::Confirm { .. } => WidgetKind::Confirm,
            Self::Input { .. } => WidgetKind::Input,
        }
    }

    fn accepts(&self, answer: &WidgetAnswer) -> bool {
        match (self, answer) {
            (Self::Pick { items, multi, .. }, WidgetAnswer::Pick { indices }) => {
                !indices.is_empty()
                    && (*multi || indices.len() == 1)
                    && indices.iter().all(|index| *index < items.len())
            }
            (Self::Confirm { .. }, WidgetAnswer::Confirm { .. }) => true,
            (Self::Input { .. }, WidgetAnswer::Input { .. }) => true,
            _ => false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum WidgetAnswer {
    Pick { indices: Vec<usize> },
    Confirm { yes: bool },
    Input { text: String },
}

/// Tabs fetch the request only for a pane they show, so a long list isn't
/// broadcast. The kind lets them take keys while that loads.
#[derive(Serialize, Clone)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WidgetSummary {
    pub id: Uuid,
    pub pane_id: Uuid,
    pub kind: WidgetKind,
}

#[derive(Clone)]
enum Progress {
    Waiting,
    Shown,
    Answered(Option<WidgetAnswer>),
}

struct Pending {
    id: Uuid,
    pane_id: Uuid,
    request: Arc<WidgetRequest>,
    progress: watch::Sender<Progress>,
}

/// Open widgets, in `SessionManager` so that connecting tabs get them.
#[derive(Default)]
pub struct Widgets(Vec<Pending>);

impl Widgets {
    pub fn summaries(&self) -> Vec<WidgetSummary> {
        self.0
            .iter()
            .map(|widget| WidgetSummary {
                id: widget.id,
                pane_id: widget.pane_id,
                kind: widget.request.kind(),
            })
            .collect()
    }

    pub fn shown(&self, id: Uuid) {
        if let Some(widget) = self.0.iter().find(|widget| widget.id == id) {
            widget.progress.send_if_modified(|progress| {
                let waiting = matches!(progress, Progress::Waiting);
                if waiting {
                    *progress = Progress::Shown;
                }
                waiting
            });
        }
    }

    /// The first answer wins, as several tabs can show one widget. `None`
    /// cancels; an answer of the wrong kind or out of range is ignored.
    pub fn answer(&self, id: Uuid, answer: Option<WidgetAnswer>) {
        let Some(widget) = self.0.iter().find(|widget| widget.id == id) else {
            return;
        };
        if answer
            .as_ref()
            .is_some_and(|answer| !widget.request.accepts(answer))
        {
            return;
        }
        widget.progress.send_if_modified(|progress| {
            let open = !matches!(progress, Progress::Answered(_));
            if open {
                *progress = Progress::Answered(answer);
            }
            open
        });
    }
}

fn broadcast(mgr: &SessionManager) {
    let msg = ServerMessage::Widgets {
        widgets: mgr.widgets.summaries(),
    };
    let _ = mgr.events().send(serde_json::to_string(&msg).unwrap());
}

/// Closes the widget however the request ends, including the CLI going away.
struct OpenWidget {
    state: AppState,
    id: Uuid,
}

impl Drop for OpenWidget {
    fn drop(&mut self) {
        let (state, id) = (self.state.clone(), self.id);
        tokio::spawn(async move {
            let mut mgr = state.write().await;
            mgr.widgets.0.retain(|widget| widget.id != id);
            broadcast(&mgr);
        });
    }
}

/// Replies once the user answers: `{"answer": ...}`, `null` if canceled.
pub async fn api_widget(
    State(state): State<AppState>,
    Path(pane_id): Path<Uuid>,
    Json(request): Json<WidgetRequest>,
) -> Response {
    if matches!(&request, WidgetRequest::Pick { items, .. } if items.is_empty()) {
        return (StatusCode::BAD_REQUEST, "nothing to pick").into_response();
    }
    let id = Uuid::new_v4();
    let (progress, mut watcher) = watch::channel(Progress::Waiting);
    {
        let mut mgr = state.write().await;
        if mgr.find_pane(pane_id).is_none() {
            return StatusCode::NOT_FOUND.into_response();
        }
        if mgr.widgets.0.iter().any(|widget| widget.pane_id == pane_id) {
            return (StatusCode::CONFLICT, "this pane already has a widget open").into_response();
        }
        mgr.widgets.0.push(Pending {
            id,
            pane_id,
            request: Arc::new(request),
            progress,
        });
        broadcast(&mgr);
    }
    let _open = OpenWidget {
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
        .map(|progress| progress.clone())
    {
        Ok(Progress::Answered(answer)) => answer,
        _ => None,
    };
    Json(serde_json::json!({ "answer": answer })).into_response()
}

pub async fn api_widget_request(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let request = {
        let mgr = state.read().await;
        let widget = mgr.widgets.0.iter().find(|widget| widget.id == id);
        widget.map(|widget| widget.request.clone())
    };
    match request {
        Some(request) => Json(&*request).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Each NUL-terminated item, taken whole, and its menu item.
fn parse_whole_items(input: &[u8]) -> Vec<(&[u8], PickItem)> {
    input
        .split(|&byte| byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let label = String::from_utf8_lossy(value).into_owned();
            (
                value,
                PickItem {
                    label,
                    description: None,
                },
            )
        })
        .collect()
}

/// As `filterPick` in the frontend: contains every whitespace-separated term, ignoring case.
fn matches_query(item: &PickItem, query: &str) -> bool {
    let label = item.label.to_lowercase();
    let description = item.description.as_deref().map(str::to_lowercase);
    query.split_whitespace().all(|term| {
        let term = term.to_lowercase();
        label.contains(&term)
            || description
                .as_ref()
                .is_some_and(|text| text.contains(&term))
    })
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

pub(crate) fn pane_id() -> Result<String, String> {
    std::env::var("BTMUX_PANE_ID")
        .ok()
        .filter(|pane| !pane.is_empty())
        .ok_or("this must run in a btmux pane".into())
}

/// Shows the widget and waits: `None` if canceled.
async fn show(pane: &str, request: &WidgetRequest) -> Result<Option<WidgetAnswer>, String> {
    let body = serde_json::to_value(request).map_err(|error| error.to_string())?;
    let reply = crate::api_client::request(
        None,
        reqwest::Method::POST,
        &format!("/api/panes/{pane}/widget"),
        Some(body),
        NO_TIMEOUT,
    )
    .await?;
    let reply: Reply = serde_json::from_str(&reply).map_err(|error| error.to_string())?;
    Ok(reply.answer)
}

#[derive(Deserialize)]
struct Reply {
    answer: Option<WidgetAnswer>,
}

fn exit_code(result: Result<i32, String>) -> i32 {
    result.unwrap_or_else(|error| {
        eprintln!("btmux: {error}");
        EXIT_FAILED
    })
}

/// A reader that went away doesn't change the answer.
fn print_item(value: &[u8], end: u8) {
    let mut stdout = std::io::stdout();
    let _ = stdout
        .write_all(value)
        .and_then(|()| stdout.write_all(&[end]));
}

fn print_line(value: &[u8]) {
    print_item(value, b'\n');
}

#[derive(clap::Args, Clone, Default)]
pub struct PickArgs {
    /// Placeholder for the menu's filter.
    #[arg(long)]
    pub(crate) prompt: Option<String>,
    /// The filter's initial text.
    #[arg(long, short)]
    pub(crate) query: Option<String>,
    /// Let Tab mark several items, printed in input order.
    #[arg(long, short)]
    pub(crate) multi: bool,
    /// Keep input order while filtering, rather than ranking label prefixes first.
    #[arg(long)]
    pub(crate) no_sort: bool,
    /// Items end in NUL rather than a newline and are taken whole, with no descriptions.
    #[arg(long)]
    pub(crate) read0: bool,
    /// End printed items in NUL rather than a newline.
    #[arg(long)]
    pub(crate) print0: bool,
    /// Print the item without a menu if only one matches the query.
    #[arg(long, short = '1')]
    pub(crate) select_1: bool,
    /// Exit 1 without a menu if nothing matches the query.
    #[arg(long, short = '0')]
    pub(crate) exit_0: bool,
    /// Print marked items in the order marked, as fzf does.
    #[arg(skip)]
    pub(crate) selection_order: bool,
}

pub async fn pick(args: &PickArgs) -> i32 {
    exit_code(run_pick(args).await)
}

async fn run_pick(args: &PickArgs) -> Result<i32, String> {
    let pane = pane_id()?;
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err("pick reads its items from stdin".into());
    }
    let mut input = Vec::new();
    stdin
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    let parsed = if args.read0 {
        parse_whole_items(&input)
    } else {
        parse_items(&input)
    };
    pick_from(&pane, args, parsed).await
}

/// Shows the menu, unless the arguments or items make it unnecessary, and prints the choice.
pub(crate) async fn pick_from(
    pane: &str,
    args: &PickArgs,
    parsed: Vec<(&[u8], PickItem)>,
) -> Result<i32, String> {
    let (values, items): (Vec<_>, Vec<_>) = parsed.into_iter().unzip();
    if items.is_empty() {
        return Ok(EXIT_NOTHING_TO_PICK);
    }
    let end = if args.print0 { 0 } else { b'\n' };
    let query = args.query.as_deref().unwrap_or_default();
    if args.select_1 || args.exit_0 {
        let mut matching = (0..items.len()).filter(|&index| matches_query(&items[index], query));
        match (matching.next(), matching.next()) {
            (None, _) if args.exit_0 => return Ok(EXIT_NOTHING_TO_PICK),
            (Some(index), None) if args.select_1 => {
                print_item(values[index], end);
                return Ok(0);
            }
            _ => {}
        }
    }
    let request = WidgetRequest::Pick {
        prompt: args.prompt.clone(),
        items,
        query: args.query.clone(),
        multi: args.multi,
        no_sort: args.no_sort,
    };
    let Some(WidgetAnswer::Pick { mut indices }) = show(pane, &request).await? else {
        return Ok(EXIT_CANCELED);
    };
    let mut seen = std::collections::HashSet::new();
    indices.retain(|index| seen.insert(*index));
    if !args.selection_order {
        indices.sort_unstable();
    }
    for index in indices {
        let value = values.get(index).ok_or("the server chose no such item")?;
        print_item(value, end);
    }
    Ok(0)
}

pub async fn confirm(message: &str, default_yes: bool) -> i32 {
    exit_code(run_confirm(message, default_yes).await)
}

async fn run_confirm(message: &str, default_yes: bool) -> Result<i32, String> {
    let request = WidgetRequest::Confirm {
        message: message.to_owned(),
        default_yes,
    };
    Ok(match show(&pane_id()?, &request).await? {
        Some(WidgetAnswer::Confirm { yes: true }) => 0,
        Some(WidgetAnswer::Confirm { yes: false }) => EXIT_NO,
        _ => EXIT_CANCELED,
    })
}

pub async fn input(prompt: Option<&str>, default: Option<&str>) -> i32 {
    exit_code(run_input(prompt, default).await)
}

async fn run_input(prompt: Option<&str>, default: Option<&str>) -> Result<i32, String> {
    let request = WidgetRequest::Input {
        prompt: prompt.map(str::to_owned),
        default: default.map(str::to_owned),
    };
    let Some(WidgetAnswer::Input { text }) = show(&pane_id()?, &request).await? else {
        return Ok(EXIT_CANCELED);
    };
    print_line(text.as_bytes());
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

    #[test]
    fn whole_items_keep_their_newlines_and_tabs() {
        let parsed = parse_whole_items(b"one\ntwo\tthree\0\0four\0");
        let values: Vec<_> = parsed.iter().map(|(value, _)| *value).collect();
        assert_eq!(values, [&b"one\ntwo\tthree"[..], b"four"]);
        assert_eq!(parsed[0].1.label, "one\ntwo\tthree");
        assert!(parsed[0].1.description.is_none());
    }

    #[test]
    fn queries_match_every_term_in_label_or_description() {
        let item = PickItem {
            label: "Alpha".into(),
            description: Some("First Note".into()),
        };
        for query in ["", "  ", "alpha", "ALP note", "first"] {
            assert!(matches_query(&item, query), "{query}");
        }
        for query in ["beta", "alpha beta"] {
            assert!(!matches_query(&item, query), "{query}");
        }
    }

    #[test]
    fn only_a_multiple_menu_accepts_several_items() {
        let pick = |multi| WidgetRequest::Pick {
            prompt: None,
            query: None,
            multi,
            no_sort: false,
            items: ["a", "b"]
                .map(|label| PickItem {
                    label: label.into(),
                    description: None,
                })
                .into(),
        };
        let answer = |indices: &[usize]| WidgetAnswer::Pick {
            indices: indices.to_vec(),
        };
        assert!(pick(false).accepts(&answer(&[1])));
        assert!(!pick(false).accepts(&answer(&[0, 1])));
        assert!(pick(true).accepts(&answer(&[0, 1])));
        assert!(!pick(true).accepts(&answer(&[])));
        assert!(!pick(true).accepts(&answer(&[0, 2])));
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

    const PICK: &str = r#"{"type":"pick","prompt":"p","items":[{"label":"a","description":null},{"label":"b","description":"note"}]}"#;

    fn open(app: &Router, pane: Uuid) -> tokio::task::JoinHandle<(StatusCode, serde_json::Value)> {
        open_with(app, pane, PICK)
    }

    fn open_with(
        app: &Router,
        pane: Uuid,
        body: &'static str,
    ) -> tokio::task::JoinHandle<(StatusCode, serde_json::Value)> {
        let app = app.clone();
        tokio::spawn(async move {
            let response = app
                .oneshot(
                    Request::post(format!("/api/panes/{pane}/widget"))
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
            if let Some(widget) = state.read().await.widgets.summaries().first() {
                return widget.id;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the widget never opened");
    }

    async fn closed(state: &AppState) {
        for _ in 0..200 {
            if state.read().await.widgets.summaries().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the widget never closed");
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
        state.read().await.widgets.shown(id);
        // Shown widgets wait for the user.
        tokio::time::sleep(SHOW_TIMEOUT * 2).await;
        assert!(!request.is_finished());

        let items = app
            .clone()
            .oneshot(
                Request::get(format!("/api/widgets/{id}"))
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
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Pick { indices: vec![99] }));
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Pick { indices: vec![] }));
            mgr.widgets.answer(
                id,
                Some(WidgetAnswer::Pick {
                    indices: vec![0, 1],
                }),
            );
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Confirm { yes: true }));
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Pick { indices: vec![1] }));
            mgr.widgets.answer(id, None);
        }
        let (status, reply) = request.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["answer"]["indices"], serde_json::json!([1]));
        closed(&state).await;
    }

    #[tokio::test]
    async fn a_pane_has_one_widget_and_cancel_replies_null() {
        let (state, app, pane) = app().await;
        let first = open(&app, pane);
        let id = open_id(&state).await;
        let (status, _) = open(&app, pane).await.unwrap();
        assert_eq!(status, StatusCode::CONFLICT);
        state.read().await.widgets.answer(id, None);
        let (status, reply) = first.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(reply["answer"].is_null());
    }

    #[tokio::test]
    async fn a_dropped_request_closes_the_widget() {
        let (state, app, pane) = app().await;
        let request = open(&app, pane);
        let id = open_id(&state).await;
        state.read().await.widgets.shown(id);
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
                Request::post(format!("/api/panes/{pane}/widget"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"type":"pick","prompt":null,"items":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn confirm_and_input_answer_with_their_own_kind() {
        let (state, app, pane) = app().await;
        let request = open_with(
            &app,
            pane,
            r#"{"type":"confirm","message":"Sure?","default_yes":false}"#,
        );
        let id = open_id(&state).await;
        {
            let mgr = state.read().await;
            assert!(mgr.widgets.summaries()[0].kind == WidgetKind::Confirm);
            mgr.widgets.shown(id);
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Pick { indices: vec![0] }));
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Confirm { yes: true }));
        }
        let (status, reply) = request.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["answer"]["yes"], true);
        closed(&state).await;

        let request = open_with(
            &app,
            pane,
            r#"{"type":"input","prompt":"Name","default":"x"}"#,
        );
        let id = open_id(&state).await;
        {
            let mgr = state.read().await;
            mgr.widgets.shown(id);
            mgr.widgets
                .answer(id, Some(WidgetAnswer::Confirm { yes: true }));
            let text = String::new();
            mgr.widgets.answer(id, Some(WidgetAnswer::Input { text }));
        }
        let (status, reply) = request.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            reply["answer"]["text"], "",
            "an empty answer isn't a cancel"
        );
    }
}
