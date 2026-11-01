//! `/vscode/`: a shared VS Code server (`code serve-web`, or opt-in
//! `openvscode-server`), started on first request and proxied (HTTP and
//! WebSocket) over a private Unix socket. It runs without a connection token,
//! so the auth middleware in front of this proxy is its only access control.
//!
//! The bundled extension (`extras/vscode`) is installed into the profile's
//! extensions and connects back over a second private socket
//! (`BTMUX_VSCODE_SOCKET`), which carries newline-delimited JSON: user
//! settings and keybindings to use, the color palette and terminal font, and
//! files to open. With `[vscode] desktop` (or explicit paths), btmux shares
//! desktop VS Code's settings, keybindings, and extensions.
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
    ClientConfig, VscodeConfig, VscodeServer as Kind, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE,
    DEFAULT_FONT_WEIGHT,
};
use crate::ws::nvim::PrivateDir;

/// Mount point; the server is told to serve everything under it.
pub const BASE_PATH: &str = "/vscode";
/// macOS app bundle location, for when `code` isn't on `PATH`.
const MACOS_CODE: &str = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
/// Marks the user's acceptance of the VS Code Server license, per profile.
const LICENSE_FILE: &str = "license-accepted";

static SERVER: LazyLock<Mutex<Option<Server>>> = LazyLock::new(|| Mutex::new(None));
/// Which server to start; from `[vscode] server`.
static KIND: std::sync::Mutex<Kind> = std::sync::Mutex::new(Kind::Code);
/// Accepted without a profile to remember it in.
static LICENSE_ACCEPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Per-profile user data and extensions.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// What VS Code shares with desktop VS Code.
static SHARED: LazyLock<watch::Sender<Shared>> =
    LazyLock::new(|| watch::channel(Shared::default()).0);
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

/// A settings, keybindings, or extensions path, and whether it was configured
/// explicitly rather than found as desktop VS Code's (missing is then an error).
#[derive(Clone, Debug, PartialEq)]
struct Source {
    path: PathBuf,
    explicit: bool,
}

/// Desktop VS Code's (or configured) user files, sent to each VS Code window,
/// and extension folders, linked when the server starts.
#[derive(Clone, Debug, Default, PartialEq)]
struct Shared {
    settings: Option<Source>,
    keybindings: Option<Source>,
    extensions: Vec<Source>,
}

impl Shared {
    fn new(config: &VscodeConfig) -> Self {
        let explicit = |value: &String| Source {
            path: expand_home(value),
            explicit: true,
        };
        let desktop = |path: Option<PathBuf>| {
            path.filter(|_| config.desktop).map(|path| Source {
                path,
                explicit: false,
            })
        };
        // `~/Library/Application Support/Code/User` on macOS, else `$XDG_CONFIG_HOME/Code/User`.
        let user = dirs::config_dir().map(|dir| dir.join("Code").join("User"));
        Self {
            settings: config
                .settings
                .as_ref()
                .map(explicit)
                .or_else(|| desktop(user.as_ref().map(|dir| dir.join("settings.json")))),
            keybindings: config
                .keybindings
                .as_ref()
                .map(explicit)
                .or_else(|| desktop(user.as_ref().map(|dir| dir.join("keybindings.json")))),
            extensions: match &config.extensions {
                Some(dirs) => dirs.iter().map(explicit).collect(),
                None => desktop(dirs::home_dir().map(|home| home.join(".vscode/extensions")))
                    .into_iter()
                    .collect(),
            },
        }
    }
}

fn expand_home(value: &str) -> PathBuf {
    match (value.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(value),
    }
}

pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// Pick the server to start next, what to share with desktop VS Code, and show
/// the btmux color scheme and terminal font in VS Code.
pub fn configure(config: &ClientConfig) {
    *KIND.lock().unwrap() = config.vscode.server;
    let shared = Shared::new(&config.vscode);
    SHARED.send_if_modified(|current| {
        let changed = *current != shared;
        if changed {
            *current = shared;
        }
        changed
    });
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
    let mut entries = read_registry(&registry);
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

/// The entries of an `extensions.json`, or none.
fn read_registry(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read(path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

/// An extension's `publisher.name` and version, from its manifest.
fn manifest_id(dir: &Path) -> Option<(String, String)> {
    manifest_id_from(&std::fs::read(dir.join("package.json")).ok()?)
}

fn manifest_id_from(data: &[u8]) -> Option<(String, String)> {
    let manifest: serde_json::Value = serde_json::from_slice(data).ok()?;
    Some((
        format!(
            "{}.{}",
            manifest["publisher"].as_str()?,
            manifest["name"].as_str()?
        ),
        manifest["version"].as_str()?.to_owned(),
    ))
}

/// The extension folders in `source`: itself if it is one, else those its
/// `extensions.json` registers (as desktop VS Code and Home Manager keep
/// them), else its subfolders.
fn find_extensions(source: &Path) -> std::io::Result<Vec<PathBuf>> {
    if source.join("package.json").is_file() {
        return Ok(vec![source.to_owned()]);
    }
    let registry = source.join("extensions.json");
    let found: Vec<PathBuf> = if registry.is_file() {
        // Folders VS Code has uninstalled or replaced but not yet deleted.
        let obsolete: serde_json::Map<String, serde_json::Value> =
            std::fs::read(source.join(".obsolete"))
                .ok()
                .and_then(|data| serde_json::from_slice(&data).ok())
                .unwrap_or_default();
        read_registry(&registry)
            .iter()
            .filter_map(|entry| match &entry["relativeLocation"] {
                serde_json::Value::String(relative) => Some(source.join(relative)),
                _ => match &entry["location"] {
                    serde_json::Value::String(location) => Some(source.join(location)),
                    location => location["path"].as_str().map(PathBuf::from),
                },
            })
            .filter(|dir| {
                dir.file_name()
                    .is_none_or(|name| !obsolete.contains_key(&*name.to_string_lossy()))
            })
            .collect()
    } else {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(source)?
            .flatten()
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| entry.path())
            .collect();
        dirs.sort();
        dirs
    };
    Ok(found
        .into_iter()
        .filter(|dir| dir.join("package.json").is_file())
        .collect())
}

/// Register the extensions in `sources` in `extensions`' `extensions.json` by
/// absolute location, replacing those `linked` lists from last time and other
/// installs of the same extensions. The bundled extension stays as it is.
fn link_extensions(extensions: &Path, linked: &Path, sources: &[Source]) -> Result<(), String> {
    let error = |path: &Path, e: std::io::Error| format!("{}: {e}", path.display());
    let bundled = Extension::get("package.json")
        .and_then(|file| manifest_id_from(&file.data))
        .map(|(id, _)| id.to_ascii_lowercase());
    let mut wanted: Vec<serde_json::Value> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for source in sources {
        let dirs = match find_extensions(&source.path) {
            Ok(dirs) => dirs,
            Err(e) if !source.explicit && e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                tracing::warn!("VS Code extensions: {}", error(&source.path, e));
                continue;
            }
        };
        for dir in dirs {
            let Some((id, version)) = manifest_id(&dir) else {
                tracing::warn!("VS Code extension without an id: {}", dir.display());
                continue;
            };
            let key = id.to_ascii_lowercase();
            if bundled.as_ref() == Some(&key) || ids.contains(&key) {
                continue;
            }
            ids.push(key);
            wanted.push(serde_json::json!({
                "identifier": { "id": id },
                "version": version,
                "location": { "$mid": 1, "path": dir, "scheme": "file" },
            }));
        }
    }

    let previous: Vec<String> = std::fs::read(linked)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let registry = extensions.join("extensions.json");
    let original = read_registry(&registry);
    let mut entries: Vec<serde_json::Value> = original
        .iter()
        .filter(|entry| {
            entry["identifier"]["id"].as_str().is_none_or(|id| {
                let id = id.to_ascii_lowercase();
                !previous.contains(&id) && !ids.contains(&id)
            })
        })
        .cloned()
        .collect();
    entries.extend(wanted);
    if entries != original {
        std::fs::create_dir_all(extensions).map_err(|e| error(extensions, e))?;
        std::fs::write(&registry, serde_json::to_vec(&entries).unwrap())
            .map_err(|e| error(&registry, e))?;
    }
    if previous != ids {
        std::fs::write(linked, serde_json::to_vec(&ids).unwrap()).map_err(|e| error(linked, e))?;
    }
    Ok(())
}

/// Parse JSON with comments and trailing commas, as VS Code's settings allow.
fn parse_jsonc(text: &str) -> serde_json::Result<serde_json::Value> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // Drop comments.
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            plain.push(c);
            match c {
                '\\' => plain.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('/', Some('/')) => while chars.next_if(|&c| c != '\n').is_some() {},
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
                plain.push(' ');
            }
            _ => {
                in_string = c == '"';
                plain.push(c);
            }
        }
    }
    // Drop trailing commas.
    let mut json = String::with_capacity(plain.len());
    let mut in_string = false;
    let mut escaped = false;
    for (i, c) in plain.char_indices() {
        if in_string {
            in_string = escaped || c != '"';
            escaped = !escaped && c == '\\';
        } else if c == '"' {
            in_string = true;
        } else if c == ',' && plain[i + 1..].trim_start().starts_with(['}', ']']) {
            continue;
        }
        json.push(c);
    }
    serde_json::from_str(&json)
}

/// Read a shared settings or keybindings file. Desktop VS Code's may be missing.
async fn read_user_file(source: &Source) -> Option<serde_json::Value> {
    let path = source.path.display();
    let text = match tokio::fs::read_to_string(&source.path).await {
        Ok(text) => text,
        Err(e) if !source.explicit && e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!("VS Code: {path}: {e}");
            return None;
        }
    };
    if text.trim().is_empty() {
        return None;
    }
    parse_jsonc(&text)
        .inspect_err(|e| tracing::warn!("VS Code: {path}: {e}"))
        .ok()
}

/// The `user` message: settings and keybindings for VS Code's user files, each
/// `null` to leave that file alone.
async fn user_message(shared: &Shared) -> Option<String> {
    let mut settings = None;
    if let Some(source) = &shared.settings {
        settings = read_user_file(source).await;
        if settings.as_ref().is_some_and(|value| !value.is_object()) {
            tracing::warn!("VS Code: {}: not an object", source.path.display());
            settings = None;
        }
    }
    let mut keybindings = None;
    if let Some(source) = &shared.keybindings {
        keybindings = read_user_file(source).await;
        if keybindings.as_ref().is_some_and(|value| !value.is_array()) {
            tracing::warn!("VS Code: {}: not an array", source.path.display());
            keybindings = None;
        }
    }
    (settings.is_some() || keybindings.is_some()).then(|| {
        serde_json::json!({ "type": "user", "settings": settings, "keybindings": keybindings })
            .to_string()
    })
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

/// Send the user files, the style, a pending or recent open, and then every
/// change, until it disconnects.
#[cfg(unix)]
async fn serve_extension(stream: UnixStream) {
    let (mut reader, mut writer) = stream.into_split();
    let mut shared = SHARED.subscribe();
    let current = shared.borrow_and_update().clone();
    let user = user_message(&current).await;
    let mut style = STYLE.subscribe();
    let mut opens = OPENS.subscribe();
    let recent = LAST_OPEN
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(at, _)| at.is_none_or(|at| at.elapsed() < OPEN_REPLAY))
        .map(|(_, message)| message.clone());
    let mut pending: Vec<String> = user
        .into_iter()
        .chain(style.borrow_and_update().clone())
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
            changed = shared.changed() => {
                if changed.is_err() {
                    return;
                }
                let current = shared.borrow_and_update().clone();
                pending.extend(user_message(&current).await);
            }
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

/// The program `kind` runs, if installed.
fn program(kind: Kind) -> Option<PathBuf> {
    match kind {
        Kind::Code => find_on_path("code")
            .or_else(|| Some(PathBuf::from(MACOS_CODE)).filter(|path| path.is_file())),
        Kind::OpenvscodeServer => find_on_path("openvscode-server"),
    }
}

/// Whether the VS Code surface can start `kind`.
pub fn available(kind: Kind) -> bool {
    cfg!(unix) && program(kind).is_some()
}

/// The server command, minus the options both servers share.
fn server_command(kind: Kind, data: &Path) -> Result<Command, String> {
    Ok(match kind {
        Kind::Code => {
            let code = program(kind).ok_or(
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
            let binary = program(kind)
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
    let extensions = data.join("extensions");
    if let Err(error) = install_extension(&extensions) {
        tracing::warn!("btmux VS Code extension: {error}");
    }
    let sources = SHARED.borrow().extensions.clone();
    if let Err(error) = link_extensions(&extensions, &data.join("linked-extensions.json"), &sources)
    {
        tracing::warn!("VS Code extensions: {error}");
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

    #[test]
    fn parses_settings_with_comments_and_trailing_commas() {
        let value = parse_jsonc(
            "\u{feff}{\n  // line\n  \"a\": \"//not a comment\", /* block */\n  \"b\": [1, 2,],\n  \"c\": \"q\\\",\",\n}\n",
        )
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "a": "//not a comment", "b": [1, 2], "c": "q\"," })
        );
        assert!(parse_jsonc("{\"a\": }").is_err());
    }

    fn write_extension(dir: &Path, publisher: &str, name: &str, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            serde_json::json!({ "publisher": publisher, "name": name, "version": version })
                .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn links_shared_extensions_and_replaces_them_later() {
        let root =
            std::env::temp_dir().join(format!("btmux-vscode-{}", uuid::Uuid::new_v4().simple()));
        let extensions = root.join("data/extensions");
        let linked = root.join("data/linked-extensions.json");
        // A desktop folder registered by `extensions.json`, with an obsolete entry.
        let desktop = root.join("desktop");
        write_extension(
            &desktop.join("vscodevim.vim-1.0.0"),
            "vscodevim",
            "vim",
            "1.0.0",
        );
        write_extension(&desktop.join("old.ext-1.0.0"), "old", "ext", "1.0.0");
        write_extension(
            &root.join("store/rust"),
            "rust-lang",
            "rust-analyzer",
            "0.4.0",
        );
        std::fs::write(
            desktop.join("extensions.json"),
            serde_json::json!([
                { "identifier": { "id": "vscodevim.vim" }, "version": "1.0.0",
                  "location": { "$mid": 1, "path": "/elsewhere", "scheme": "file" },
                  "relativeLocation": "vscodevim.vim-1.0.0" },
                { "identifier": { "id": "old.ext" }, "version": "1.0.0",
                  "relativeLocation": "old.ext-1.0.0" },
                { "identifier": { "id": "rust-lang.rust-analyzer" }, "version": "0.4.0",
                  "location": { "$mid": 1, "path": root.join("store/rust"), "scheme": "file" } },
            ])
            .to_string(),
        )
        .unwrap();
        std::fs::write(desktop.join(".obsolete"), r#"{"old.ext-1.0.0":true}"#).unwrap();
        // A folder of extensions without a registry, and a single extension.
        let folder = root.join("folder");
        write_extension(&folder.join("a"), "Pub", "a", "2.0.0");
        write_extension(&folder.join("vim"), "vscodevim", "vim", "0.9.0");
        write_extension(&root.join("single"), "pub", "single", "3.0.0");
        // Installed in btmux before: one replaced by a shared one, one kept.
        std::fs::create_dir_all(&extensions).unwrap();
        std::fs::write(
            extensions.join("extensions.json"),
            r#"[{"identifier":{"id":"btmux.btmux"},"version":"0.0.1","relativeLocation":"btmux.btmux-0.0.1"},
                {"identifier":{"id":"pub.A"},"version":"1.0.0","relativeLocation":"pub.a-1.0.0"},
                {"identifier":{"id":"user.ext"},"version":"1.0.0","relativeLocation":"user.ext-1.0.0"}]"#,
        )
        .unwrap();
        let source = |path: PathBuf| Source {
            path,
            explicit: true,
        };
        let registered = || -> Vec<(String, Option<String>)> {
            read_registry(&extensions.join("extensions.json"))
                .iter()
                .map(|entry| {
                    (
                        entry["identifier"]["id"].as_str().unwrap().to_owned(),
                        entry["location"]["path"].as_str().map(str::to_owned),
                    )
                })
                .collect()
        };
        let path = |p: PathBuf| Some(p.to_string_lossy().into_owned());

        link_extensions(
            &extensions,
            &linked,
            &[
                source(desktop.clone()),
                source(folder.clone()),
                source(root.join("single")),
                source(root.join("missing")),
            ],
        )
        .unwrap();
        assert_eq!(
            registered(),
            [
                ("btmux.btmux".into(), None),
                ("user.ext".into(), None),
                (
                    "vscodevim.vim".into(),
                    path(desktop.join("vscodevim.vim-1.0.0"))
                ),
                (
                    "rust-lang.rust-analyzer".into(),
                    path(root.join("store/rust"))
                ),
                ("Pub.a".into(), path(folder.join("a"))),
                ("pub.single".into(), path(root.join("single"))),
            ]
        );

        // Unchanged sources rewrite nothing; removed ones are unlinked.
        let modified = std::fs::metadata(extensions.join("extensions.json"))
            .unwrap()
            .modified()
            .unwrap();
        let sources = [
            source(desktop.clone()),
            source(folder.clone()),
            source(root.join("single")),
        ];
        link_extensions(&extensions, &linked, &sources).unwrap();
        assert_eq!(
            std::fs::metadata(extensions.join("extensions.json"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        link_extensions(&extensions, &linked, &[source(root.join("single"))]).unwrap();
        assert_eq!(
            registered(),
            [
                ("btmux.btmux".into(), None),
                ("user.ext".into(), None),
                ("pub.single".into(), path(root.join("single"))),
            ]
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shares_desktop_files_unless_paths_are_given() {
        assert_eq!(Shared::new(&VscodeConfig::default()), Shared::default());
        let config: VscodeConfig =
            toml::from_str("desktop = true\nkeybindings = \"/k.json\"\nextensions = []").unwrap();
        let shared = Shared::new(&config);
        let settings = shared.settings.unwrap();
        assert!(settings.path.ends_with("Code/User/settings.json") && !settings.explicit);
        assert_eq!(
            shared.keybindings,
            Some(Source {
                path: "/k.json".into(),
                explicit: true
            })
        );
        assert!(shared.extensions.is_empty());
    }
}
