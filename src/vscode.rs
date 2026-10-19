//! `/vscode/`: a shared VS Code server (`code serve-web`, or opt-in
//! `openvscode-server`), started on first request and proxied (HTTP and
//! WebSocket) over a private Unix socket. It runs without a connection token,
//! so the auth middleware in front of this proxy is its only access control.
//!
//! The bundled extension (`extras/vscode`) is installed into the profile's
//! extensions and connects back over a second private socket
//! (`BTMUX_VSCODE_SOCKET`), which carries newline-delimited JSON: the color
//! palette and terminal font, and files to open.
//!
//! Not yet supported on Windows.
#![cfg_attr(windows, allow(dead_code))]

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hyper_util::rt::TokioIo;
use rust_embed::Embed;
use serde::Serialize;
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::NamedPipeClient as UnixStream;
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, watch, Mutex};
use tokio::task::JoinHandle;

use crate::config::{
    ClientConfig, VscodeServer as Kind, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_FONT_WEIGHT,
};
use crate::ws::nvim::PrivateDir;

/// Mount point; the server is told to serve everything under it.
pub const BASE_PATH: &str = "/vscode";
/// macOS app bundle location, for when `code` isn't on `PATH`.
const MACOS_CODE: &str = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
/// Marks the user's acceptance of the VS Code Server license, per profile.
const LICENSE_FILE: &str = "license-accepted";

static SERVER: LazyLock<Mutex<Option<Server>>> = LazyLock::new(|| Mutex::new(None));
/// Which server to start; from `vscode-server`.
static KIND: std::sync::Mutex<Kind> = std::sync::Mutex::new(Kind::Code);
/// Accepted without a profile to remember it in.
static LICENSE_ACCEPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Per-profile user data and extensions.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The `style` message for the current color scheme and terminal font.
static STYLE: LazyLock<watch::Sender<Option<String>>> = LazyLock::new(|| watch::channel(None).0);
/// `open` messages for connected extension hosts.
static OPENS: LazyLock<broadcast::Sender<String>> = LazyLock::new(|| broadcast::channel(16).0);
/// The latest `open` and when an extension host first received it. It's
/// replayed to hosts that connect before then, as VS Code may still be waiting
/// on its license or starting, and soon after, as it may be reloading into
/// another folder.
static LAST_OPEN: std::sync::Mutex<Option<(Option<Instant>, String)>> = std::sync::Mutex::new(None);
const OPEN_REPLAY: Duration = Duration::from_secs(30);

#[derive(Embed)]
#[folder = "extras/vscode"]
struct Extension;

struct Server {
    child: Child,
    directory: PrivateDir,
    extension_listener: JoinHandle<()>,
    /// Recent output, reported if it exits before it's ready.
    output: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    readers: Vec<JoinHandle<()>>,
}

impl Server {
    fn socket(&self) -> PathBuf {
        self.directory.path().join("code.sock")
    }
}

impl Drop for Server {
    /// The binary may be a wrapper script, so kill its whole process group.
    fn drop(&mut self) {
        self.extension_listener.abort();
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: killpg has no memory-safety preconditions.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
        }
        #[cfg(windows)]
        let _ = self.child.start_kill();
    }
}

pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// Pick the server to start next, and show the btmux color scheme and
/// terminal font in VS Code.
pub fn configure(config: &ClientConfig) {
    *KIND.lock().unwrap() = config.vscode_server;
    let terminal = &config.terminal;
    let message = serde_json::json!({
        "type": "style",
        "palette": config.color_palette,
        "font": {
            "family": terminal.font_family.as_deref().unwrap_or(DEFAULT_FONT_FAMILY),
            "size": terminal.font_size.unwrap_or(DEFAULT_FONT_SIZE),
            "weight": terminal.font_weight.unwrap_or(DEFAULT_FONT_WEIGHT),
        },
    })
    .to_string();
    STYLE.send_if_modified(|current| {
        let changed = current.as_ref() != Some(&message);
        if changed {
            *current = Some(message);
        }
        changed
    });
}

/// Open `path` in VS Code. The browser shows the surface, starting VS Code if needed.
pub fn open(path: &str, line: Option<u32>) {
    let message = serde_json::json!({ "type": "open", "path": path, "line": line }).to_string();
    *LAST_OPEN.lock().unwrap() = Some((None, message.clone()));
    let _ = OPENS.send(message);
}

/// Install the bundled extension into `extensions` and register it in VS
/// Code's `extensions.json`, replacing other builds. The folder name includes a
/// content hash, so any change re-registers it and VS Code rescans; nothing
/// current is rewritten, which would needlessly invalidate VS Code's cache.
fn install_extension(extensions: &Path) -> Result<(), String> {
    let error = |e: std::io::Error| format!("{}: {e}", extensions.display());
    let manifest: serde_json::Value =
        serde_json::from_slice(&Extension::get("package.json").expect("manifest").data)
            .map_err(|e| format!("extras/vscode/package.json: {e}"))?;
    let id = format!(
        "{}.{}",
        manifest["publisher"].as_str().unwrap(),
        manifest["name"].as_str().unwrap()
    );
    let version = manifest["version"].as_str().unwrap();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for name in Extension::iter() {
        name.hash(&mut hasher);
        Extension::get(&name).unwrap().data.hash(&mut hasher);
    }
    let folder = format!("{id}-{version}-{:08x}", hasher.finish() as u32);
    let dir = extensions.join(&folder);

    std::fs::create_dir_all(extensions).map_err(error)?;
    for entry in std::fs::read_dir(extensions).map_err(error)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&format!("{id}-")) && name != folder {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    for name in Extension::iter() {
        let data = Extension::get(&name).expect("embedded file").data;
        let path = dir.join(name.as_ref());
        if std::fs::read(&path).is_ok_and(|current| *current == *data) {
            continue;
        }
        std::fs::create_dir_all(path.parent().unwrap())
            .and_then(|()| std::fs::write(&path, &data))
            .map_err(error)?;
    }

    let registry = extensions.join("extensions.json");
    let mut entries: Vec<serde_json::Value> = std::fs::read(&registry)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let ours = |entry: &serde_json::Value| {
        entry["identifier"]["id"]
            .as_str()
            .is_some_and(|other| other.eq_ignore_ascii_case(&id))
    };
    let current = entries
        .iter()
        .any(|entry| ours(entry) && entry["relativeLocation"] == folder.as_str());
    if !current {
        entries.retain(|entry| !ours(entry));
        entries.push(serde_json::json!({
            "identifier": { "id": id },
            "version": version,
            "location": { "$mid": 1, "path": dir, "scheme": "file" },
            "relativeLocation": folder,
        }));
        std::fs::write(&registry, serde_json::to_vec(&entries).unwrap()).map_err(error)?;
    }
    Ok(())
}

/// Accept connections from the bundled extension.
#[cfg(unix)]
fn listen_for_extension(path: &Path) -> Result<JoinHandle<()>, String> {
    let listener = UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_extension(stream));
        }
    }))
}

/// Send the style, a pending or recent open, and then every change, until it
/// disconnects.
#[cfg(unix)]
async fn serve_extension(stream: UnixStream) {
    let (mut reader, mut writer) = stream.into_split();
    let mut style = STYLE.subscribe();
    let mut opens = OPENS.subscribe();
    let recent = LAST_OPEN
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(at, _)| at.is_none_or(|at| at.elapsed() < OPEN_REPLAY))
        .map(|(_, message)| message.clone());
    let mut pending: Vec<String> = style
        .borrow_and_update()
        .clone()
        .into_iter()
        .chain(recent)
        .collect();
    let mut buf = [0u8; 64];
    loop {
        for message in pending.drain(..) {
            if writer
                .write_all(format!("{message}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
            if let Some((at, last)) = LAST_OPEN.lock().unwrap().as_mut() {
                if *last == message {
                    at.get_or_insert_with(Instant::now);
                }
            }
        }
        tokio::select! {
            changed = style.changed() => {
                if changed.is_err() {
                    return;
                }
                pending.extend(style.borrow_and_update().clone());
            }
            open = opens.recv() => match open {
                Ok(message) => pending.push(message),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
            read = reader.read(&mut buf) => {
                if !matches!(read, Ok(n) if n > 0) {
                    return;
                }
            }
        }
    }
}

/// `code serve-web` needs the user to accept the VS Code Server license.
fn license_accepted() -> bool {
    LICENSE_ACCEPTED.load(std::sync::atomic::Ordering::Relaxed)
        || DATA_DIR
            .get()
            .is_some_and(|dir| dir.join(LICENSE_FILE).exists())
}

fn accept_license() -> Result<(), String> {
    LICENSE_ACCEPTED.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(dir) = DATA_DIR.get() {
        std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(dir.join(LICENSE_FILE), ""))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The server command, minus the options both servers share.
fn server_command(kind: Kind, data: &Path) -> Result<Command, String> {
    Ok(match kind {
        Kind::Code => {
            let code = find_on_path("code")
                .or_else(|| Some(PathBuf::from(MACOS_CODE)).filter(|path| path.is_file()))
                .ok_or(
                    "VS Code's `code` command was not found. Install Visual Studio Code \
                        (e.g. `brew install --cask visual-studio-code`) and its `code` command.",
                )?;
            let mut command = Command::new(code);
            command
                .args([
                    "serve-web",
                    "--accept-server-license-terms",
                    "--disable-telemetry",
                ])
                .arg("--server-data-dir")
                .arg(data)
                .env("VSCODE_CLI_NONINTERACTIVE", "1");
            command
        }
        Kind::OpenvscodeServer => {
            let binary = find_on_path("openvscode-server")
                .ok_or("`openvscode-server` (vscode-server = \"openvscode-server\") was not found on PATH.")?;
            let mut command = Command::new(binary);
            command
                .args(["--telemetry-level", "off"])
                .arg("--user-data-dir")
                .arg(data.join("data"))
                .arg("--extensions-dir")
                .arg(data.join("extensions"));
            command
        }
    })
}

#[cfg(windows)]
fn spawn(_kind: Kind) -> Result<Server, String> {
    Err("The VS Code surface isn't supported on Windows yet.".into())
}

#[cfg(unix)]
fn spawn(kind: Kind) -> Result<Server, String> {
    let directory = PrivateDir::new()?;
    let data = match DATA_DIR.get() {
        Some(dir) => dir.clone(),
        None => directory.path().join("data"),
    };
    // Both servers keep extensions under `<data>/extensions`.
    if let Err(error) = install_extension(&data.join("extensions")) {
        tracing::warn!("btmux VS Code extension: {error}");
    }
    let extension_socket = directory.path().join("btmux.sock");
    let mut child = server_command(kind, &data)?
        .env("BTMUX_VSCODE_SOCKET", &extension_socket)
        .arg("--socket-path")
        .arg(directory.path().join("code.sock"))
        .args([
            "--server-base-path",
            BASE_PATH,
            "--without-connection-token",
        ])
        .current_dir(dirs::home_dir().unwrap_or_else(|| "/".into()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("start {kind:?}: {e}"))?;
    let extension_listener = match listen_for_extension(&extension_socket) {
        Ok(listener) => listener,
        Err(error) => {
            // SAFETY: killpg has no memory-safety preconditions.
            if let Some(pid) = child.id() {
                unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
            }
            return Err(error);
        }
    };
    let output = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
    let mut readers = Vec::new();
    for out in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
    ]
    .into_iter()
    .flatten()
    {
        let output = output.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "btmux::vscode", "{line}");
                let mut output = output.lock().unwrap();
                if output.len() == 20 {
                    output.pop_front();
                }
                output.push_back(line);
            }
        }));
    }
    Ok(Server {
        child,
        directory,
        extension_listener,
        output,
        readers,
    })
}

#[derive(Debug)]
enum StartError {
    /// The user hasn't accepted the VS Code Server license yet.
    License,
    Failed(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::License => f.write_str("the VS Code Server license hasn't been accepted"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

async fn connect_socket(path: &Path) -> std::io::Result<UnixStream> {
    #[cfg(unix)]
    return UnixStream::connect(path).await;
    #[cfg(windows)]
    tokio::net::windows::named_pipe::ClientOptions::new().open(path)
}

/// Start the server if it isn't running, then connect to it.
async fn connect() -> Result<UnixStream, StartError> {
    let mut server = SERVER.lock().await;
    let running = server
        .as_mut()
        .is_some_and(|server| matches!(server.child.try_wait(), Ok(None)));
    if running {
        if let Ok(stream) = connect_socket(&server.as_ref().unwrap().socket()).await {
            return Ok(stream);
        }
    } else {
        let kind = *KIND.lock().unwrap();
        if kind == Kind::Code && !license_accepted() {
            return Err(StartError::License);
        }
        *server = Some(spawn(kind).map_err(StartError::Failed)?);
    }
    let running = server.as_mut().unwrap();
    // Node takes a moment to start listening.
    for _ in 0..300 {
        if let Ok(stream) = connect_socket(&running.socket()).await {
            return Ok(stream);
        }
        if let Ok(Some(status)) = running.child.try_wait() {
            for reader in running.readers.drain(..) {
                let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
            }
            let output = Vec::from(running.output.lock().unwrap().clone()).join("\n");
            *server = None;
            return Err(StartError::Failed(format!(
                "VS Code exited ({status}):\n{output}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(StartError::Failed(
        "VS Code didn't start listening within 30 s".into(),
    ))
}

/// For `/api/vscode`: whether VS Code is ready to show.
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum VscodeStatus {
    Ready,
    /// Ask the user to accept the VS Code Server license (`POST /api/vscode/license`).
    License,
    Error {
        message: String,
    },
}

/// `GET /api/vscode`: start VS Code if needed and report whether it's ready.
pub async fn status() -> Json<VscodeStatus> {
    Json(match connect().await {
        Ok(_) => VscodeStatus::Ready,
        Err(StartError::License) => VscodeStatus::License,
        Err(StartError::Failed(message)) => VscodeStatus::Error { message },
    })
}

/// `POST /api/vscode/license`: the user accepted the license; start VS Code.
pub async fn accept() -> Json<VscodeStatus> {
    if let Err(message) = accept_license() {
        return Json(VscodeStatus::Error { message });
    }
    status().await
}

pub async fn shutdown() {
    drop(SERVER.lock().await.take());
}

/// Forward a request, including WebSocket upgrades, to the server.
pub async fn proxy(mut request: Request) -> Response {
    match forward(&mut request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!("vscode proxy: {error}");
            (StatusCode::BAD_GATEWAY, error).into_response()
        }
    }
}

async fn forward(request: &mut Request) -> Result<Response, String> {
    let stream = connect().await.map_err(|e| e.to_string())?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });

    let upgrade = request
        .headers()
        .get(header::UPGRADE)
        .is_some()
        .then(|| hyper::upgrade::on(&mut *request));
    let mut outgoing = Request::new(std::mem::take(request.body_mut()));
    *outgoing.method_mut() = request.method().clone();
    *outgoing.uri_mut() = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(BASE_PATH)
        .parse()
        .map_err(|e: axum::http::uri::InvalidUri| e.to_string())?;
    *outgoing.headers_mut() = request.headers().clone();
    outgoing.headers_mut().remove(header::AUTHORIZATION);

    let mut response = sender
        .send_request(outgoing)
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let server = hyper::upgrade::on(&mut response);
        if let Some(client) = upgrade {
            tokio::spawn(async move {
                if let (Ok(client), Ok(server)) = tokio::join!(client, server) {
                    let _ = tokio::io::copy_bidirectional(
                        &mut TokioIo::new(client),
                        &mut TokioIo::new(server),
                    )
                    .await;
                }
            });
        }
    }
    Ok(response.map(Body::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_and_registers_the_extension_once() {
        let dir =
            std::env::temp_dir().join(format!("btmux-vscode-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("btmux.btmux-0.0.0")).unwrap();
        let registry = dir.join("extensions.json");
        std::fs::write(
            &registry,
            r#"[{"identifier":{"id":"other.ext"},"version":"1.0.0","location":"a","relativeLocation":"other.ext-1.0.0"},
                {"identifier":{"id":"btmux.btmux"},"version":"0.0.0","location":"b","relativeLocation":"btmux.btmux-0.0.0"}]"#,
        )
        .unwrap();

        install_extension(&dir).unwrap();
        let entries: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&registry).unwrap()).unwrap();
        let folder = entries[1]["relativeLocation"].as_str().unwrap().to_owned();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["identifier"]["id"], "other.ext");
        assert!(folder.starts_with("btmux.btmux-") && folder != "btmux.btmux-0.0.0");
        assert!(dir.join(&folder).join("extension.js").is_file());
        assert!(!dir.join("btmux.btmux-0.0.0").exists());

        // A current install rewrites nothing, so VS Code's cache stays valid.
        let modified = std::fs::metadata(&registry).unwrap().modified().unwrap();
        install_extension(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&registry).unwrap().modified().unwrap(),
            modified
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
