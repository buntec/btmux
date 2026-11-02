//! `/ws/browser`: one shared headless Chromium per server, showing one page.
//! Driven over `--remote-debugging-pipe`, so it opens no port. Each tab gets
//! JPEG frames for a canvas and sends input back as CDP input events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket},
        Query, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch, Mutex, Notify};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const JPEG_QUALITY: u32 = 80;
/// How long a page stays quiet before its final frame is captured.
const SETTLE_DELAY: Duration = Duration::from_millis(150);
/// Frame header: page width and height in CSS px (u16s).
const HEADER_LEN: usize = 4;
const STDERR_LINES: usize = 10;
/// How often the cursor under the pointer is looked up while it moves.
const CURSOR_INTERVAL: Duration = Duration::from_millis(50);
/// The page to reopen, in the profile.
const LAST_URL_FILE: &str = "btmux-last-url";

/// CDP doesn't report the cursor, so ask the page what is under the pointer.
const CURSOR_SCRIPT: &str = r#"(x, y) => {
  let doc = document, el;
  for (;;) {
    el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el?.tagName !== 'IFRAME') break;
    let inner = null;
    try { inner = el.contentDocument; } catch {}
    if (!inner) break;
    const box = el.getBoundingClientRect();
    x -= box.left + el.clientLeft;
    y -= box.top + el.clientTop;
    doc = inner;
  }
  if (!el) return 'default';
  const style = getComputedStyle(el);
  if (style.cursor !== 'auto') return style.cursor;
  if (el.isContentEditable) return 'text';
  if (style.userSelect === 'none') return 'default';
  const node = doc.caretRangeFromPoint?.(x, y)?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return 'default';
  const range = doc.createRange();
  range.selectNodeContents(node);
  const over = [...range.getClientRects()].some(
    (b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom,
  );
  return over ? 'text' : 'default';
}"#;

/// The selected text, as a browser would copy it: never a password field's.
const COPY_SCRIPT: &str = r#"(() => {
  const read = (doc) => {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active?.tagName === 'IFRAME') {
      let inner = null;
      try { inner = active.contentDocument; } catch {}
      const text = inner && read(inner);
      if (text) return text;
    }
    if (active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT') {
      if (active.type === 'password') return '';
      const text = (active.value ?? '').slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
      if (text) return text;
    }
    return doc.getSelection()?.toString() ?? '';
  };
  return read(document);
})()"#;

/// CSS cursors a tab may show. A page's `url()` cursors would load in the
/// tab, outside the sandbox of the server's browser.
const CURSORS: &[&str] = &[
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "e-resize",
    "n-resize",
    "ne-resize",
    "nw-resize",
    "s-resize",
    "se-resize",
    "sw-resize",
    "w-resize",
    "ew-resize",
    "ns-resize",
    "nesw-resize",
    "nwse-resize",
    "col-resize",
    "row-resize",
    "all-scroll",
    "zoom-in",
    "zoom-out",
];

const PATH_PROGRAMS: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
];
const MACOS_APPS: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// CDP input modifier bits.
const ALT: u8 = 1;
const META: u8 = 4;
const SHIFT: u8 = 8;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static SERVER: LazyLock<Mutex<Option<Arc<Browser>>>> = LazyLock::new(|| Mutex::new(None));

pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

fn program() -> Option<PathBuf> {
    PATH_PROGRAMS
        .iter()
        .find_map(|name| crate::vscode::find_on_path(name))
        .or_else(|| {
            MACOS_APPS
                .iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
        })
}

/// Whether the browser surface can start Chromium.
pub fn available() -> bool {
    cfg!(unix) && program().is_some()
}

/// From a tab.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum BrowserClientMessage {
    /// The last frame was drawn, so send the latest.
    Ack,
    /// The tab's viewport, in CSS px.
    Resize {
        width: u32,
        height: u32,
    },
    Key {
        down: bool,
        key: String,
        code: String,
        key_code: u32,
        text: Option<String>,
        modifiers: u8,
        repeat: bool,
    },
    Mouse {
        /// CDP's `mousePressed`, `mouseReleased`, `mouseMoved`, or `mouseWheel`.
        kind: String,
        x: f64,
        y: f64,
        /// CDP's `none`, `left`, `middle`, or `right`.
        button: String,
        buttons: u8,
        click_count: u8,
        modifiers: u8,
        delta_x: f64,
        delta_y: f64,
    },
    /// Pasted text, or text from an IME or a phone keyboard.
    InsertText {
        text: String,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    /// Send the page's selected text back as `Clipboard`.
    Copy,
}

/// To a tab; frames are binary.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum BrowserServerMessage {
    Page {
        url: String,
        title: String,
        loading: bool,
    },
    /// A CSS cursor, from `CURSORS`.
    Cursor {
        cursor: String,
    },
    /// The reply to `Copy`; empty if nothing is selected.
    Clipboard {
        text: String,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Default)]
struct PageState {
    url: String,
    title: String,
    loading: bool,
}

/// Which tab sizes the page: the first, until another sends input (as with PTYs).
#[derive(Default)]
struct Viewers {
    next: u64,
    owner: Option<u64>,
    sizes: HashMap<u64, Option<(u32, u32)>>,
    applied: Option<(u32, u32)>,
}

impl Viewers {
    fn join(&mut self) -> u64 {
        let id = self.next;
        self.next += 1;
        self.sizes.insert(id, None);
        self.owner.get_or_insert(id);
        id
    }

    /// The size to apply, if the owner's changed.
    fn owner_size(&mut self) -> Option<(u32, u32)> {
        let size = (*self.sizes.get(&self.owner?)?)?;
        (self.applied != Some(size)).then(|| {
            self.applied = Some(size);
            size
        })
    }

    fn resize(&mut self, id: u64, size: (u32, u32)) -> Option<(u32, u32)> {
        self.sizes.insert(id, Some(size));
        self.owner_size()
    }

    fn claim(&mut self, id: u64) -> Option<(u32, u32)> {
        if !self.sizes.contains_key(&id) {
            return None;
        }
        self.owner = Some(id);
        self.owner_size()
    }

    fn leave(&mut self, id: u64) -> Option<(u32, u32)> {
        self.sizes.remove(&id);
        if self.owner != Some(id) {
            return None;
        }
        self.owner = self.sizes.keys().min().copied();
        self.owner_size()
    }
}

/// Calls waiting for their replies, by id.
type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Clone)]
struct Cdp {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next: Arc<AtomicU64>,
}

impl Cdp {
    fn write(&self, id: u64, session: Option<&str>, method: &str, params: Value) {
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        let _ = self.tx.send(bytes);
    }

    /// Send without waiting for the reply, keeping input in order.
    fn post(&self, session: Option<&str>, method: &str, params: Value) {
        self.write(
            self.next.fetch_add(1, Ordering::Relaxed),
            session,
            method,
            params,
        );
    }

    async fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(id, session, method, params);
        let reply = tokio::time::timeout(CALL_TIMEOUT, rx).await;
        self.pending.lock().unwrap().remove(&id);
        match reply {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Chromium closed the connection".into()),
            Err(_) => Err(format!("{method} timed out")),
        }
    }
}

struct Browser {
    cdp: Cdp,
    session: String,
    target: String,
    /// `--force-device-scale-factor`, fixed for the process.
    scale: u32,
    page: watch::Sender<PageState>,
    frames: watch::Sender<Option<Bytes>>,
    /// Something painted or may have; see `settle`.
    painted: Notify,
    last_capture: std::sync::Mutex<Option<Instant>>,
    /// The pointer's latest position, until `track_cursor` takes it.
    pointer: std::sync::Mutex<Option<(f64, f64)>>,
    pointer_moved: Notify,
    cursor: watch::Sender<String>,
    closed: watch::Receiver<bool>,
    viewers: std::sync::Mutex<Viewers>,
    /// Pages opened by `window.open` or `target=_blank`, until their URL is known.
    popups: std::sync::Mutex<HashSet<String>>,
    /// Sending or dropping this kills Chromium.
    kill: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Browser {
    fn post(&self, method: &str, params: Value) {
        self.cdp.post(Some(&self.session), method, params);
    }

    fn start_screencast(&self, size: Option<(u32, u32)>) {
        let mut params = json!({ "format": "jpeg", "quality": JPEG_QUALITY });
        // Without these, a frame keeps its scale from before a shrink.
        if let Some((width, height)) = size {
            params["maxWidth"] = (width * self.scale).into();
            params["maxHeight"] = (height * self.scale).into();
        }
        self.post("Page.startScreencast", params);
    }

    fn apply_size(&self, size: Option<(u32, u32)>) {
        let Some((width, height)) = size else { return };
        // Scale 0 keeps `--force-device-scale-factor`; a value here gives 1x frames.
        self.post(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width,
                "height": height,
                "deviceScaleFactor": 0,
                "mobile": false,
                // Headless defaults to 400x300, which sites take for a phone.
                "screenWidth": width,
                "screenHeight": height,
            }),
        );
        self.start_screencast(size);
        self.painted.notify_one();
    }

    fn join(&self) -> u64 {
        let mut viewers = self.viewers.lock().unwrap();
        let id = viewers.join();
        if viewers.sizes.len() == 1 {
            self.start_screencast(viewers.applied);
            self.painted.notify_one();
        }
        id
    }

    fn leave(&self, id: u64) {
        let mut viewers = self.viewers.lock().unwrap();
        let size = viewers.leave(id);
        if viewers.sizes.is_empty() {
            self.post("Page.stopScreencast", json!({}));
        } else {
            self.apply_size(size);
        }
    }

    fn resize(&self, id: u64, width: u32, height: u32) {
        let size = (width.max(1), height.max(1));
        let size = self.viewers.lock().unwrap().resize(id, size);
        self.apply_size(size);
    }

    fn claim(&self, id: u64) {
        let size = self.viewers.lock().unwrap().claim(id);
        self.apply_size(size);
    }

    /// `Back` or `Forward`.
    async fn go(&self, offset: i64) -> Result<(), String> {
        let history = self
            .cdp
            .call(Some(&self.session), "Page.getNavigationHistory", json!({}))
            .await?;
        let index = history["currentIndex"].as_i64().unwrap_or(0) + offset;
        let entry = usize::try_from(index)
            .ok()
            .and_then(|index| history["entries"].get(index));
        if let Some(id) = entry.and_then(|entry| entry["id"].as_i64()) {
            self.post("Page.navigateToHistoryEntry", json!({ "entryId": id }));
        }
        Ok(())
    }

    fn publish(&self, data: &str, width: u16, height: u16) {
        let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(data) else {
            return;
        };
        let mut frame = Vec::with_capacity(HEADER_LEN + jpeg.len());
        frame.extend(width.to_be_bytes());
        frame.extend(height.to_be_bytes());
        frame.extend(jpeg);
        self.frames.send_replace(Some(frame.into()));
    }

    fn on_frame(&self, params: &Value) {
        // At once, so a slow tab can't hold up the others; tabs skip to the latest.
        self.post(
            "Page.screencastFrameAck",
            json!({ "sessionId": params["sessionId"] }),
        );
        let metadata = &params["metadata"];
        self.publish(
            params["data"].as_str().unwrap_or_default(),
            metadata["deviceWidth"].as_f64().unwrap_or(0.0) as u16,
            metadata["deviceHeight"].as_f64().unwrap_or(0.0) as u16,
        );
        // A capture makes Chromium send a frame, which mustn't start another.
        let capturing = self
            .last_capture
            .lock()
            .unwrap()
            .is_some_and(|at| at.elapsed() < SETTLE_DELAY);
        if !capturing {
            self.painted.notify_one();
        }
    }

    /// Capture the page once it's quiet. The screencast can't show a quiet
    /// page's final state: it misses a paint made while it attaches, and its
    /// last frame may be low resolution, with no later frame to correct it.
    async fn settle(self: Arc<Self>) {
        let mut closed = self.closed.clone();
        loop {
            tokio::select! {
                _ = self.painted.notified() => {}
                _ = closed.wait_for(|closed| *closed) => return,
            }
            while tokio::time::timeout(SETTLE_DELAY, self.painted.notified())
                .await
                .is_ok()
            {}
            let size = {
                let viewers = self.viewers.lock().unwrap();
                viewers.applied.filter(|_| !viewers.sizes.is_empty())
            };
            let Some((width, height)) = size else {
                continue;
            };
            let params = json!({ "format": "jpeg", "quality": JPEG_QUALITY });
            *self.last_capture.lock().unwrap() = Some(Instant::now());
            let shot = self
                .cdp
                .call(Some(&self.session), "Page.captureScreenshot", params)
                .await;
            *self.last_capture.lock().unwrap() = Some(Instant::now());
            match shot {
                Ok(shot) => self.publish(
                    shot["data"].as_str().unwrap_or_default(),
                    width as u16,
                    height as u16,
                ),
                Err(error) => tracing::debug!(%error, "browser capture failed"),
            }
        }
    }

    /// Look up the cursor under the pointer as it moves.
    async fn track_cursor(self: Arc<Self>) {
        let mut closed = self.closed.clone();
        loop {
            tokio::select! {
                _ = self.pointer_moved.notified() => {}
                _ = closed.wait_for(|closed| *closed) => return,
            }
            let Some((x, y)) = self.pointer.lock().unwrap().take() else {
                continue;
            };
            let params = json!({
                "expression": format!("({CURSOR_SCRIPT})({x},{y})"),
                "returnByValue": true,
            });
            let reply = self
                .cdp
                .call(Some(&self.session), "Runtime.evaluate", params)
                .await;
            // Nothing to show on an error, such as during a navigation.
            if let Ok(reply) = reply {
                if let Some(value) = reply["result"]["value"].as_str() {
                    let cursor = allowed_cursor(value);
                    self.cursor.send_if_modified(|current| {
                        let changed = current != cursor;
                        if changed {
                            *current = cursor.to_string();
                        }
                        changed
                    });
                }
            }
            tokio::time::sleep(CURSOR_INTERVAL).await;
        }
    }

    /// There is one page, so a new one becomes a navigation of it.
    fn on_other_target(&self, info: &Value, id: &str) {
        let url = info["url"].as_str().unwrap_or_default();
        let mut popups = self.popups.lock().unwrap();
        if !popups.contains(id) {
            return;
        }
        if url.is_empty() || url == "about:blank" {
            return;
        }
        popups.remove(id);
        self.post("Page.navigate", json!({ "url": url }));
        self.cdp
            .post(None, "Target.closeTarget", json!({ "targetId": id }));
    }

    /// `Target.targetInfoChanged` doesn't report a title set while loading.
    fn refresh_title(self: &Arc<Self>) {
        let browser = self.clone();
        tokio::spawn(async move {
            let params = json!({ "targetId": browser.target });
            if let Ok(reply) = browser.cdp.call(None, "Target.getTargetInfo", params).await {
                if let Some(title) = reply["targetInfo"]["title"].as_str() {
                    browser.page.send_if_modified(|page| {
                        let changed = page.title != title;
                        page.title = title.to_string();
                        changed
                    });
                }
            }
        });
    }

    fn on_event(self: &Arc<Self>, message: &Value) {
        let params = &message["params"];
        let info = &params["targetInfo"];
        let info_id = info["targetId"].as_str().unwrap_or_default();
        match message["method"].as_str().unwrap_or_default() {
            "Page.screencastFrame" => self.on_frame(params),
            "Page.frameStartedLoading" | "Page.frameStoppedLoading"
                if params["frameId"].as_str() == Some(&self.target) =>
            {
                let loading = message["method"] == "Page.frameStartedLoading";
                self.page.send_modify(|page| page.loading = loading);
                if !loading {
                    self.refresh_title();
                    self.painted.notify_one();
                }
            }
            // A dialog blocks the page, and there's no UI for one yet.
            "Page.javascriptDialogOpening" => {
                let kind = params["type"].as_str().unwrap_or_default();
                self.post(
                    "Page.handleJavaScriptDialog",
                    json!({ "accept": kind == "alert" || kind == "beforeunload" }),
                );
            }
            // Only the page's own: Chromium opens internal pages, like its update page.
            "Target.targetCreated"
                if info["type"] == "page" && info["openerId"].as_str() == Some(&self.target) =>
            {
                self.popups.lock().unwrap().insert(info_id.to_string());
                self.on_other_target(info, info_id);
            }
            "Target.targetInfoChanged" if info_id == self.target => {
                let url = info["url"].as_str().unwrap_or_default();
                if restorable(url) && self.page.borrow().url != url {
                    save_last_url(url);
                }
                self.page.send_modify(|page| {
                    page.url = url.to_string();
                    page.title = info["title"].as_str().unwrap_or_default().to_string();
                });
            }
            "Target.targetInfoChanged" => self.on_other_target(info, info_id),
            "Target.targetCrashed" if params["targetId"].as_str() == Some(&self.target) => {
                self.post("Page.reload", json!({}));
            }
            // The page closed itself, which leaves nothing to show.
            "Target.targetDestroyed" if params["targetId"].as_str() == Some(&self.target) => {
                self.cdp.post(None, "Browser.close", json!({}));
            }
            _ => {}
        }
    }
}

type Pipes = (
    Child,
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
);

#[cfg(unix)]
fn spawn_process(
    program: &std::path::Path,
    profile: &std::path::Path,
    scale: u32,
) -> Result<Pipes, String> {
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::process::Stdio;
    use tokio::net::unix::pipe;

    let error = |e: std::io::Error| format!("start {}: {e}", program.display());
    // Close-on-exec, so an in-place upgrade closes them and Chromium exits.
    let (command_rd, command_wr) = std::io::pipe().map_err(error)?;
    let (reply_rd, reply_wr) = std::io::pipe().map_err(error)?;
    let (from, to) = (command_rd.as_raw_fd(), reply_wr.as_raw_fd());
    let mut command = tokio::process::Command::new(program);
    command
        .args([
            "--headless=new",
            "--remote-debugging-pipe",
            "--no-first-run",
            "--no-default-browser-check",
            // No keychain prompt from a hidden process.
            "--use-mock-keychain",
            "--password-store=basic",
            // A person drives this browser. Anything agent-driven should keep reporting automation.
            "--disable-blink-features=AutomationControlled",
        ])
        .arg(format!("--force-device-scale-factor={scale}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    // SAFETY: only async-signal-safe calls. CDP uses fds 3 and 4; either pipe
    // end may already be one of them, so move both clear first.
    unsafe {
        command.pre_exec(move || {
            let from = libc::fcntl(from, libc::F_DUPFD, 10);
            let to = libc::fcntl(to, libc::F_DUPFD, 10);
            if from < 0 || to < 0 || libc::dup2(from, 3) < 0 || libc::dup2(to, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(from);
            libc::close(to);
            Ok(())
        });
    }
    let child = command.spawn().map_err(error)?;
    let reader = pipe::Receiver::from_owned_fd(OwnedFd::from(reply_rd)).map_err(error)?;
    let writer = pipe::Sender::from_owned_fd(OwnedFd::from(command_wr)).map_err(error)?;
    Ok((child, Box::new(reader), Box::new(writer)))
}

#[cfg(not(unix))]
fn spawn_process(
    _program: &std::path::Path,
    _profile: &std::path::Path,
    _scale: u32,
) -> Result<Pipes, String> {
    Err("The browser surface isn't supported on Windows yet.".into())
}

/// Whether a page is worth reopening. Error pages and `about:` aren't.
fn restorable(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

fn save_last_url(url: &str) {
    if let Some(dir) = DATA_DIR.get() {
        if let Err(error) = std::fs::write(dir.join(LAST_URL_FILE), url) {
            tracing::debug!(%error, "saving the browser's page failed");
        }
    }
}

/// A page's computed `cursor` as a keyword, dropping any `url()` before its fallback.
fn allowed_cursor(value: &str) -> &'static str {
    let keyword = value.rsplit(',').next().unwrap_or_default().trim();
    CURSORS
        .iter()
        .find(|cursor| **cursor == keyword)
        .copied()
        .unwrap_or("default")
}

fn create_profile(path: &std::path::Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(path)
        .map_err(|e| format!("create {}: {e}", path.display()))
}

/// Split NUL-delimited CDP messages into replies and events.
async fn read_messages(
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    pending: Pending,
    events: mpsc::UnboundedSender<Value>,
) {
    let mut buffer = Vec::with_capacity(1024 * 1024);
    let mut chunk = vec![0u8; 256 * 1024];
    while let Ok(n) = reader.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let scanned = buffer.len();
        buffer.extend_from_slice(&chunk[..n]);
        let mut start = 0;
        let mut from = scanned;
        while let Some(end) = buffer[from..]
            .iter()
            .position(|&b| b == 0)
            .map(|i| from + i)
        {
            if let Ok(message) = serde_json::from_slice::<Value>(&buffer[start..end]) {
                if let Some(id) = message["id"].as_u64() {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(match message.get("error") {
                            Some(error) => {
                                Err(error["message"].as_str().unwrap_or("CDP error").to_string())
                            }
                            None => Ok(message["result"].clone()),
                        });
                    }
                } else {
                    let _ = events.send(message);
                }
            }
            start = end + 1;
            from = start;
        }
        buffer.drain(..start);
    }
    // Fail calls in flight.
    pending.lock().unwrap().clear();
}

/// Headless Chromium says so in its user agent, which some sites refuse.
fn desktop_user_agent(agent: &str) -> String {
    agent.replace("HeadlessChrome", "Chrome")
}

/// What the desktop browser reports through `navigator.userAgentData` and
/// `Sec-CH-UA`. An override without this leaves its brands empty. `product` is
/// `Browser.getVersion`'s, like `Chrome/156.0.8078.79`.
fn user_agent_metadata(product: &str, google_chrome: bool, platform_version: &str) -> Value {
    let full = product.rsplit('/').next().unwrap_or_default();
    let major = full.split('.').next().unwrap_or_default();
    let brands = |version: &str| {
        let mut brands = vec![
            json!({ "brand": "Not.A/Brand", "version": "99" }),
            json!({ "brand": "Chromium", "version": version }),
        ];
        if google_chrome {
            brands.push(json!({ "brand": "Google Chrome", "version": version }));
        }
        brands
    };
    json!({
        "brands": brands(major),
        "fullVersionList": brands(full),
        "fullVersion": full,
        "platform": if cfg!(target_os = "macos") { "macOS" } else { "Linux" },
        "platformVersion": platform_version,
        "architecture": if cfg!(target_arch = "aarch64") { "arm" } else { "x86" },
        "bitness": "64",
        "model": "",
        "mobile": false,
    })
}

async fn start(scale: u32) -> Result<Arc<Browser>, String> {
    let program = program().ok_or(
        "Chrome or Chromium was not found. Install one, on the server's PATH or in /Applications.",
    )?;
    let profile = DATA_DIR
        .get()
        .ok_or("No state directory to keep the browser profile in.")?;
    create_profile(profile)?;
    let restore = std::fs::read_to_string(profile.join(LAST_URL_FILE))
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| restorable(url));
    let (mut child, reader, mut writer) = spawn_process(&program, profile, scale)?;

    let stderr: Arc<std::sync::Mutex<VecDeque<String>>> = Arc::default();
    if let Some(output) = child.stderr.take() {
        let stderr = stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut stderr = stderr.lock().unwrap();
                if stderr.len() == STDERR_LINES {
                    stderr.pop_front();
                }
                stderr.push_back(line);
            }
        });
    }

    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let (closed_tx, closed) = watch::channel(false);
    tokio::spawn(async move {
        tokio::select! {
            _ = child.wait() => {}
            _ = kill_rx => {
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    // SAFETY: signals its own process group (`process_group(0)`).
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                }
                let _ = child.wait().await;
            }
        }
        let _ = closed_tx.send(true);
    });

    let (tx, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if writer.write_all(&message).await.is_err() {
                break;
            }
        }
    });
    let cdp = Cdp {
        tx,
        pending: Arc::default(),
        next: Arc::new(AtomicU64::new(1)),
    };
    let (events_tx, mut events) = mpsc::unbounded_channel();
    tokio::spawn(read_messages(reader, cdp.pending.clone(), events_tx));

    let setup = async {
        cdp.call(
            None,
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
        )
        .await?;
        let version = cdp.call(None, "Browser.getVersion", json!({})).await?;
        let targets = cdp.call(None, "Target.getTargets", json!({})).await?;
        let existing = targets["targetInfos"]
            .as_array()
            .and_then(|targets| targets.iter().find(|target| target["type"] == "page"))
            .and_then(|target| target["targetId"].as_str())
            .map(str::to_string);
        let target = match existing {
            Some(target) => target,
            None => cdp
                .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
                .await?["targetId"]
                .as_str()
                .ok_or("Target.createTarget returned no target")?
                .to_string(),
        };
        let attached = cdp
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .ok_or("Target.attachToTarget returned no session")?
            .to_string();
        cdp.call(Some(&session), "Page.enable", json!({})).await?;
        // Headless pages otherwise report no focus until the first input.
        cdp.call(
            Some(&session),
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true }),
        )
        .await?;
        let google_chrome = program.to_string_lossy().to_lowercase().contains("chrome");
        let platform_version = if cfg!(target_os = "macos") {
            sysinfo::System::os_version()
        } else {
            sysinfo::System::kernel_version()
        }
        .unwrap_or_default();
        cdp.call(
            Some(&session),
            "Emulation.setUserAgentOverride",
            json!({
                "userAgent": desktop_user_agent(version["userAgent"].as_str().unwrap_or_default()),
                "userAgentMetadata": user_agent_metadata(
                    version["product"].as_str().unwrap_or_default(),
                    google_chrome,
                    &platform_version,
                ),
            }),
        )
        .await?;
        Ok::<_, String>((target, session))
    };
    let (target, session) = setup.await.map_err(|error| {
        let stderr = stderr.lock().unwrap();
        let output = stderr.iter().cloned().collect::<Vec<_>>().join("\n");
        format!("Chromium didn't start: {error}\n{output}")
            .trim_end()
            .to_string()
    })?;

    let browser = Arc::new(Browser {
        cdp,
        session,
        target,
        scale,
        page: watch::Sender::new(PageState {
            url: restore.clone().unwrap_or_else(|| "about:blank".into()),
            ..PageState::default()
        }),
        frames: watch::Sender::new(None),
        painted: Notify::new(),
        last_capture: Default::default(),
        pointer: Default::default(),
        pointer_moved: Notify::new(),
        cursor: watch::Sender::new("default".into()),
        closed,
        viewers: Default::default(),
        popups: Default::default(),
        kill: std::sync::Mutex::new(Some(kill_tx)),
    });
    if let Some(url) = restore {
        browser.post("Page.navigate", json!({ "url": url }));
    }
    tokio::spawn(browser.clone().settle());
    tokio::spawn(browser.clone().track_cursor());
    let handler = browser.clone();
    tokio::spawn(async move {
        while let Some(message) = events.recv().await {
            handler.on_event(&message);
        }
    });
    Ok(browser)
}

async fn connect(scale: u32) -> Result<Arc<Browser>, String> {
    let mut server = SERVER.lock().await;
    if let Some(browser) = server.as_ref().filter(|browser| !*browser.closed.borrow()) {
        return Ok(browser.clone());
    }
    let browser = tokio::time::timeout(START_TIMEOUT, start(scale))
        .await
        .map_err(|_| "Chromium didn't start within 30 s".to_string())??;
    *server = Some(browser.clone());
    Ok(browser)
}

/// Close Chromium, killing it if it doesn't.
pub async fn shutdown() {
    let Some(browser) = SERVER.lock().await.take() else {
        return;
    };
    browser.cdp.post(None, "Browser.close", json!({}));
    let mut closed = browser.closed.clone();
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, closed.wait_for(|closed| *closed)).await;
    drop(browser.kill.lock().unwrap().take());
    let _ = closed.wait_for(|closed| *closed).await;
}

#[derive(Deserialize)]
pub struct BrowserQuery {
    dpr: Option<f64>,
}

/// The device scale for a viewer's `devicePixelRatio`; 3x frames aren't worth
/// their bandwidth.
fn device_scale(dpr: Option<f64>) -> u32 {
    (dpr.unwrap_or(1.0).ceil() as u32).clamp(1, 2)
}

pub async fn handle(ws: WebSocketUpgrade, Query(query): Query<BrowserQuery>) -> impl IntoResponse {
    let scale = device_scale(query.dpr);
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, scale))
}

fn server_message(message: &BrowserServerMessage) -> Message {
    Message::Text(serde_json::to_string(message).unwrap().into())
}

fn page_message(page: &PageState) -> Message {
    server_message(&BrowserServerMessage::Page {
        url: page.url.clone(),
        title: page.title.clone(),
        loading: page.loading,
    })
}

/// CDP's commands for macOS editing chords, which headless Chromium doesn't map.
fn mac_commands(code: &str, modifiers: u8) -> &'static [&'static str] {
    if !cfg!(target_os = "macos") {
        return &[];
    }
    let shift = modifiers & SHIFT != 0;
    let choose = |plain: &'static [&'static str], selecting: &'static [&'static str]| {
        if shift {
            selecting
        } else {
            plain
        }
    };
    match (modifiers & (META | ALT), code) {
        (META, "KeyA") => &["selectAll"],
        (META, "KeyZ") => choose(&["undo"], &["redo"]),
        (META, "ArrowLeft") => choose(
            &["moveToLeftEndOfLine"],
            &["moveToLeftEndOfLineAndModifySelection"],
        ),
        (META, "ArrowRight") => choose(
            &["moveToRightEndOfLine"],
            &["moveToRightEndOfLineAndModifySelection"],
        ),
        (META, "ArrowUp") => choose(
            &["moveToBeginningOfDocument"],
            &["moveToBeginningOfDocumentAndModifySelection"],
        ),
        (META, "ArrowDown") => choose(
            &["moveToEndOfDocument"],
            &["moveToEndOfDocumentAndModifySelection"],
        ),
        (META, "Backspace") => &["deleteToBeginningOfLine"],
        (ALT, "ArrowLeft") => choose(&["moveWordLeft"], &["moveWordLeftAndModifySelection"]),
        (ALT, "ArrowRight") => choose(&["moveWordRight"], &["moveWordRightAndModifySelection"]),
        (ALT, "Backspace") => &["deleteWordBackward"],
        (ALT, "Delete") => &["deleteWordForward"],
        _ => &[],
    }
}

fn handle_message(
    browser: &Arc<Browser>,
    viewer: u64,
    replies: &mpsc::UnboundedSender<BrowserServerMessage>,
    message: BrowserClientMessage,
) {
    match message {
        BrowserClientMessage::Copy => {
            let browser = browser.clone();
            let replies = replies.clone();
            tokio::spawn(async move {
                let params = json!({ "expression": COPY_SCRIPT, "returnByValue": true });
                let reply = browser
                    .cdp
                    .call(Some(&browser.session), "Runtime.evaluate", params)
                    .await;
                let text = reply
                    .ok()
                    .and_then(|reply| reply["result"]["value"].as_str().map(str::to_string))
                    .unwrap_or_default();
                let _ = replies.send(BrowserServerMessage::Clipboard { text });
            });
        }
        // Handled by the socket.
        BrowserClientMessage::Ack => {}
        BrowserClientMessage::Resize { width, height } => browser.resize(viewer, width, height),
        BrowserClientMessage::Key {
            down,
            key,
            code,
            key_code,
            text,
            modifiers,
            repeat,
        } => {
            let mut params = json!({
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": key_code,
                "nativeVirtualKeyCode": key_code,
                "modifiers": modifiers,
                "autoRepeat": repeat,
            });
            let kind = match (down, &text) {
                (false, _) => "keyUp",
                (true, Some(_)) => "keyDown",
                (true, None) => "rawKeyDown",
            };
            params["type"] = kind.into();
            if down {
                browser.claim(viewer);
                params["commands"] = json!(mac_commands(&code, modifiers));
                if let Some(text) = text {
                    params["text"] = text.clone().into();
                    params["unmodifiedText"] = text.into();
                }
            }
            browser.post("Input.dispatchKeyEvent", params);
        }
        BrowserClientMessage::Mouse {
            kind,
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
            delta_x,
            delta_y,
        } => {
            if kind == "mouseMoved" {
                *browser.pointer.lock().unwrap() = Some((x, y));
                browser.pointer_moved.notify_one();
            }
            browser.post(
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind,
                    "x": x,
                    "y": y,
                    "button": button,
                    "buttons": buttons,
                    "clickCount": click_count,
                    "modifiers": modifiers,
                    "deltaX": delta_x,
                    "deltaY": delta_y,
                }),
            );
            // After the click, whose coordinates are for the frame the tab was
            // showing: claiming first would resize the page under it.
            if kind == "mouseReleased" {
                browser.claim(viewer);
            }
        }
        BrowserClientMessage::InsertText { text } => {
            browser.claim(viewer);
            browser.post("Input.insertText", json!({ "text": text }));
        }
        BrowserClientMessage::Navigate { url } => {
            browser.claim(viewer);
            browser.post("Page.navigate", json!({ "url": url }));
        }
        BrowserClientMessage::Reload => browser.post("Page.reload", json!({})),
        BrowserClientMessage::Back | BrowserClientMessage::Forward => {
            let offset = if matches!(message, BrowserClientMessage::Back) {
                -1
            } else {
                1
            };
            let browser = browser.clone();
            tokio::spawn(async move {
                if let Err(error) = browser.go(offset).await {
                    tracing::warn!(%error, "browser history navigation failed");
                }
            });
        }
    }
}

async fn handle_socket(socket: WebSocket, scale: u32) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let browser = match connect(scale).await {
        Ok(browser) => browser,
        Err(message) => {
            tracing::warn!(%message, "browser unavailable");
            let message = serde_json::to_string(&BrowserServerMessage::Error { message }).unwrap();
            let _ = ws_tx.send(Message::Text(message.into())).await;
            return;
        }
    };
    let viewer = browser.join();
    let mut frames = browser.frames.subscribe();
    let mut page = browser.page.subscribe();
    let mut cursor = browser.cursor.subscribe();
    let mut closed = browser.closed.clone();
    let (replies, mut pending_replies) = mpsc::unbounded_channel();
    // A new tab gets the current page and last frame, since an idle page sends none.
    frames.mark_changed();
    page.mark_changed();
    let mut awaiting_ack = false;
    loop {
        let send = tokio::select! {
            // A tab only gets another frame after drawing one, so it never falls behind.
            changed = frames.changed(), if !awaiting_ack => {
                if changed.is_err() {
                    break;
                }
                let Some(frame) = frames.borrow_and_update().clone() else {
                    continue;
                };
                awaiting_ack = true;
                Message::Binary(frame)
            }
            changed = page.changed() => {
                if changed.is_err() {
                    break;
                }
                let message = page_message(&page.borrow_and_update());
                message
            }
            changed = cursor.changed() => {
                if changed.is_err() {
                    break;
                }
                let cursor = cursor.borrow_and_update().clone();
                server_message(&BrowserServerMessage::Cursor { cursor })
            }
            Some(reply) = pending_replies.recv() => server_message(&reply),
            _ = async { let _ = closed.wait_for(|closed| *closed).await; } => {
                let frame = CloseFrame {
                    code: close_code::ERROR,
                    reason: "Chromium exited".into(),
                };
                let _ = ws_tx.send(Message::Close(Some(frame))).await;
                break;
            }
            message = ws_rx.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<BrowserClientMessage>(&text) {
                            Ok(message) => {
                                if matches!(message, BrowserClientMessage::Ack) {
                                    awaiting_ack = false;
                                }
                                handle_message(&browser, viewer, &replies, message);
                            }
                            Err(error) => tracing::warn!(%error, "bad browser message"),
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
                continue;
            }
        };
        if !matches!(
            tokio::time::timeout(SEND_TIMEOUT, ws_tx.send(send)).await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
    browser.leave(viewer);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_viewer_sizes_the_page_until_another_sends_input() {
        let mut viewers = Viewers::default();
        let first = viewers.join();
        let second = viewers.join();
        assert_eq!(viewers.resize(first, (800, 600)), Some((800, 600)));
        assert_eq!(viewers.resize(second, (400, 300)), None);
        assert_eq!(viewers.claim(second), Some((400, 300)));
        assert_eq!(viewers.resize(first, (900, 600)), None);
        assert_eq!(viewers.claim(second), None);
        assert_eq!(viewers.leave(first), None);
        let third = viewers.join();
        assert_eq!(viewers.resize(third, (100, 100)), None);
        assert_eq!(viewers.leave(second), Some((100, 100)));
    }

    #[test]
    fn a_viewer_that_left_cannot_claim() {
        let mut viewers = Viewers::default();
        let first = viewers.join();
        let second = viewers.join();
        assert_eq!(viewers.resize(first, (800, 600)), Some((800, 600)));
        viewers.leave(second);
        assert_eq!(viewers.claim(second), None);
        assert_eq!(viewers.owner, Some(first));
    }

    #[test]
    fn device_scale_is_one_or_two() {
        assert_eq!(device_scale(None), 1);
        assert_eq!(device_scale(Some(1.0)), 1);
        assert_eq!(device_scale(Some(1.5)), 2);
        assert_eq!(device_scale(Some(3.0)), 2);
        assert_eq!(device_scale(Some(f64::NAN)), 1);
    }

    #[test]
    fn user_agent_hides_headless() {
        assert_eq!(
            desktop_user_agent("Mozilla/5.0 HeadlessChrome/156.0.0.0 Safari/537.36"),
            "Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36"
        );
    }

    #[test]
    fn cursors_are_keywords_without_page_urls() {
        assert_eq!(allowed_cursor("pointer"), "pointer");
        assert_eq!(allowed_cursor("url(\"https://x/a.png\") 2 2, grab"), "grab");
        assert_eq!(
            allowed_cursor("url(\"https://x/a,b.png\"), auto"),
            "default"
        );
        assert_eq!(allowed_cursor("url(https://x/a.png)"), "default");
        assert_eq!(allowed_cursor("bogus"), "default");
    }

    #[test]
    fn only_web_pages_are_reopened() {
        assert!(restorable("https://example.com/a"));
        assert!(restorable("http://localhost:5173/"));
        assert!(!restorable("about:blank"));
        assert!(!restorable("chrome-error://chromewebdata/"));
        assert!(!restorable("chrome://settings/help"));
        assert!(!restorable("file:///etc/passwd"));
    }

    #[test]
    fn metadata_names_the_browser_with_its_version() {
        let metadata = user_agent_metadata("Chrome/156.0.8078.79", true, "26.0");
        let brands = metadata["brands"].as_array().unwrap();
        assert!(brands.contains(&json!({ "brand": "Google Chrome", "version": "156" })));
        assert!(metadata["fullVersionList"]
            .as_array()
            .unwrap()
            .contains(&json!({ "brand": "Chromium", "version": "156.0.8078.79" })));
        assert_eq!(metadata["platformVersion"], "26.0");
        let chromium = user_agent_metadata("Chrome/156.0.8078.79", false, "");
        assert_eq!(chromium["brands"].as_array().unwrap().len(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_chords_map_to_commands() {
        assert_eq!(mac_commands("KeyA", META), ["selectAll"]);
        assert_eq!(mac_commands("KeyZ", META | SHIFT), ["redo"]);
        assert_eq!(mac_commands("ArrowLeft", ALT), ["moveWordLeft"]);
        assert!(mac_commands("KeyA", 0).is_empty());
    }
}
