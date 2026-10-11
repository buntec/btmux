//! `/ws/nvim`: the built-in Neovim UI. One shared headless Neovim per server;
//! each socket is a separate msgpack-RPC connection that attaches its own UI.

use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::LazyLock;
use std::time::Duration;

use axum::{
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket},
        WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::Embed;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex};

static SERVER: LazyLock<Mutex<Option<NvimServer>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Copy, Debug)]
enum State {
    Running,
    /// `None` if the exit status couldn't be read.
    Exited(Option<ExitStatus>),
}

struct NvimServer {
    state: watch::Receiver<State>,
    /// Dropping this kills Neovim.
    kill: oneshot::Sender<()>,
    /// Neovim's `--embed` RPC channel.
    stdin: ChildStdin,
    directory: PrivateDir,
}

impl NvimServer {
    fn running(&self) -> bool {
        matches!(*self.state.borrow(), State::Running)
    }

    fn socket(&self) -> PathBuf {
        self.directory.0.join("nvim.sock")
    }

    /// Listen on the socket again after something (e.g. a tmp cleaner)
    /// removed it, keeping Neovim and its unsaved buffers.
    async fn relisten(&mut self) -> Result<(), String> {
        let dir = &self.directory.0;
        match std::fs::symlink_metadata(dir) {
            Err(e) if e.kind() == ErrorKind::NotFound => create_private_dir(dir)?,
            // SAFETY: geteuid has no preconditions.
            Ok(meta)
                if meta.is_dir()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.mode() & 0o077 == 0 => {}
            _ => return Err(format!("{} is no longer private", dir.display())),
        }
        install_plugin(&dir.join("plugin"))?;
        let socket = self.socket();
        let _ = std::fs::remove_file(&socket);
        // Neovim still has the address registered, so stop it first.
        let request = rpc_request(
            "nvim_exec_lua",
            "local p = ...; vim.fn.serverstop(p); vim.fn.serverstart(p)",
            &socket.to_string_lossy(),
        );
        self.stdin
            .write_all(&request)
            .await
            .map_err(|e| format!("write to nvim: {e}"))
    }
}

/// msgpack-RPC request `[0, 0, method, [first, [arg]]]`; the reply is ignored.
fn rpc_request(method: &str, first: &str, arg: &str) -> Vec<u8> {
    fn str(out: &mut Vec<u8>, s: &str) {
        match s.len() {
            n if n < 32 => out.push(0xa0 | n as u8),
            n if n < 256 => out.extend([0xd9, n as u8]),
            n => {
                out.push(0xda);
                out.extend((n as u16).to_be_bytes());
            }
        }
        out.extend(s.as_bytes());
    }
    let mut out = vec![0x94, 0x00, 0x00];
    str(&mut out, method);
    out.push(0x92);
    str(&mut out, first);
    out.push(0x91);
    str(&mut out, arg);
    out
}

/// Atomic creation rejects existing directories and symlinks.
fn create_private_dir(path: &Path) -> Result<(), String> {
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|e| format!("create {}: {e}", path.display()))
}

struct PrivateDir(PathBuf);

impl PrivateDir {
    fn new() -> Result<Self, String> {
        Self::create(std::env::temp_dir().join(format!("btmux-{}", uuid::Uuid::new_v4().simple())))
    }

    fn create(path: PathBuf) -> Result<Self, String> {
        create_private_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The btmux Neovim plugin (UI support for completion docs, signature help, …).
#[derive(Embed)]
#[folder = "extras/nvim"]
struct Plugin;

/// Write the embedded plugin under `dir`.
fn install_plugin(dir: &Path) -> Result<(), String> {
    for name in Plugin::iter() {
        let file = Plugin::get(&name).expect("embedded file");
        let path = dir.join(name.as_ref());
        std::fs::create_dir_all(path.parent().unwrap())
            .and_then(|()| std::fs::write(&path, file.data))
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Oldest Neovim the built-in UI supports.
const MIN_VERSION: (u32, u32) = (0, 12);

/// Whether `nvim` on `PATH` is new enough for the built-in UI. Checked once.
pub fn available() -> bool {
    static AVAILABLE: LazyLock<bool> = LazyLock::new(|| {
        std::process::Command::new("nvim")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .and_then(|out| parse_version(&String::from_utf8_lossy(&out.stdout)))
            .is_some_and(|version| version >= MIN_VERSION)
    });
    *AVAILABLE
}

/// `(major, minor)` from `nvim --version` output (`NVIM v0.12.1`, `NVIM v0.13.0-dev-…`).
fn parse_version(output: &str) -> Option<(u32, u32)> {
    let version = output.lines().next()?.strip_prefix("NVIM v")?;
    let mut parts = version.split(['.', '-']);
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// Spawn the shared Neovim if it isn't running, then connect to it.
async fn connect() -> Result<(UnixStream, PathBuf, watch::Receiver<State>), String> {
    let mut server = SERVER.lock().await;
    match server.as_mut().filter(|server| server.running()) {
        Some(running) => match UnixStream::connect(running.socket()).await {
            Ok(stream) => return Ok((stream, running.socket(), running.state.clone())),
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                running.relisten().await?;
            }
            Err(_) => {}
        },
        None => *server = Some(spawn()?),
    }
    let (path, state) = {
        let server = server.as_ref().unwrap();
        (server.socket(), server.state.clone())
    };
    drop(server);

    let mut last_error = String::new();
    for _ in 0..50 {
        match UnixStream::connect(&path).await {
            Ok(stream) => return Ok((stream, path, state)),
            Err(e) => last_error = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Err(format!("connect to nvim: {last_error}"))
}

fn spawn() -> Result<NvimServer, String> {
    let directory = PrivateDir::new()?;
    let path = directory.0.join("nvim.sock");
    let plugin = directory.0.join("plugin");
    install_plugin(&plugin)?;
    // A JSON string is a valid Lua string literal for any path.
    let plugin = serde_json::to_string(&plugin.to_string_lossy()).unwrap();
    // `--embed` ties Neovim's lifetime to our stdin pipe; `--headless`
    // keeps it from waiting for a UI on stdio. `g:btmux` lets user config
    // adapt (e.g. skip scroll animation plugins); the plugin is on
    // 'runtimepath' and `package.path` before user config so it can
    // `require("btmux")`. Plugin managers may reset 'runtimepath'
    // (lazy.nvim does by default), so `-c` restores it after user config
    // and loads the plugin if Neovim skipped it.
    let mut child = Command::new("nvim")
        .args(["--embed", "--headless", "--cmd", "let g:btmux = 1", "--cmd"])
        .arg(format!(
            "lua local p = {plugin}; vim.opt.rtp:prepend(p); \
             package.path = p .. '/lua/?.lua;' .. p .. '/lua/?/init.lua;' .. package.path"
        ))
        .arg("-c")
        .arg(format!(
            "lua local p = {plugin}; if not vim.tbl_contains(vim.opt.rtp:get(), p) then \
             vim.opt.rtp:prepend(p); vim.cmd.runtime('plugin/btmux.lua') end"
        ))
        .arg("--listen")
        .arg(&path)
        .current_dir(dirs::home_dir().unwrap_or_else(|| "/".into()))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn nvim: {e}"))?;
    // Drain broadcast notifications so the stdio channel never blocks.
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            while matches!(stdout.read(&mut buf).await, Ok(n) if n > 0) {}
        });
    }
    let stdin = child.stdin.take().expect("piped stdin");
    let (state_tx, state) = watch::channel(State::Running);
    let (kill, kill_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status,
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        state_tx.send_replace(State::Exited(status.ok()));
    });
    Ok(NvimServer {
        state,
        kill,
        stdin,
        directory,
    })
}

/// Open `path` in the shared Neovim, starting it if needed.
pub async fn open(path: &str, line: Option<u32>) -> Result<(), String> {
    let (stream, addr, _) = connect().await?;
    drop(stream);
    super::control::remote_open_in_editor(&addr.to_string_lossy(), path, line)
        .await
        .map_err(|()| "Neovim did not open the file".into())
}

/// File of the built-in Neovim's current buffer; `None` if it isn't running.
pub async fn current_file() -> Option<String> {
    let addr = {
        let server = SERVER.lock().await;
        server.as_ref().filter(|server| server.running())?.socket()
    };
    super::control::neovim_current_file(&addr.to_string_lossy()).await
}

pub async fn shutdown() {
    if let Some(NvimServer {
        mut state, kill, ..
    }) = SERVER.lock().await.take()
    {
        drop(kill);
        let _ = state
            .wait_for(|state| matches!(state, State::Exited(_)))
            .await;
    }
}

pub async fn handle(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (stream, mut state) = match connect().await {
        Ok((stream, _, state)) => (stream, state),
        Err(error) => {
            tracing::warn!(%error, "nvim UI unavailable");
            let _ = ws_tx.send(Message::Text(error.into())).await;
            return;
        }
    };
    let (mut rd, mut wr) = stream.into_split();

    let up = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(bytes) => {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    let down = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => {
                    // The channel closes just before Neovim exits.
                    let exited = state.wait_for(|state| matches!(state, State::Exited(_)));
                    let state = match tokio::time::timeout(Duration::from_secs(2), exited).await {
                        Ok(Ok(state)) => *state,
                        _ => State::Running,
                    };
                    let _ = ws_tx.send(Message::Close(Some(close_frame(state)))).await;
                    break;
                }
                Err(e) => {
                    let frame = CloseFrame {
                        code: close_code::ERROR,
                        reason: format!("read from nvim: {e}").into(),
                    };
                    let _ = ws_tx.send(Message::Close(Some(frame))).await;
                    break;
                }
                Ok(n) => {
                    if ws_tx
                        .send(Message::Binary(buf[..n].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

/// Only a clean exit (`:q`) closes the UI; anything else offers a restart.
fn close_frame(state: State) -> CloseFrame {
    let (code, reason) = match state {
        State::Exited(Some(status)) if status.success() => {
            (close_code::NORMAL, "Neovim exited".into())
        }
        State::Exited(Some(status)) => (close_code::ERROR, format!("Neovim exited ({status})")),
        State::Exited(None) => (close_code::ERROR, "Neovim exited".into()),
        State::Running => (close_code::ERROR, "Neovim closed the connection".into()),
    };
    CloseFrame {
        code,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn plugin_installs_with_entry_points() {
        let dir = PrivateDir::new().unwrap();
        install_plugin(&dir.0).unwrap();
        assert!(dir.0.join("plugin/btmux.lua").is_file());
        assert!(dir.0.join("lua/btmux/init.lua").is_file());
    }

    #[test]
    fn only_a_clean_exit_closes_the_ui() {
        use std::os::unix::process::ExitStatusExt;
        let code = |state| close_frame(state).code;
        assert_eq!(
            code(State::Exited(Some(ExitStatus::from_raw(0)))),
            close_code::NORMAL
        );
        assert_eq!(
            code(State::Exited(Some(ExitStatus::from_raw(1 << 8)))),
            close_code::ERROR
        );
        // SIGSEGV
        let crash = close_frame(State::Exited(Some(ExitStatus::from_raw(11))));
        assert_eq!(crash.code, close_code::ERROR);
        assert!(crash.reason.contains("signal: 11"), "{}", crash.reason);
        assert_eq!(code(State::Exited(None)), close_code::ERROR);
        assert_eq!(code(State::Running), close_code::ERROR);
    }

    #[test]
    fn encodes_rpc_requests() {
        assert_eq!(
            rpc_request("m", "f", "a"),
            [0x94, 0, 0, 0xa1, b'm', 0x92, 0xa1, b'f', 0x91, 0xa1, b'a']
        );
        let long = "x".repeat(300);
        let request = rpc_request("m", "f", &long);
        assert_eq!(request[9..12], [0xda, 0x01, 0x2c]);
        assert_eq!(request.len(), 12 + 300);
    }

    #[tokio::test]
    async fn reconnects_after_the_socket_is_removed() {
        if !available() {
            return;
        }
        let (_, path, state) = connect().await.unwrap();
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        let (_, again, _) = connect().await.unwrap();
        assert_eq!(again, path);
        assert!(
            matches!(*state.borrow(), State::Running),
            "Neovim was replaced"
        );
        assert!(path
            .parent()
            .unwrap()
            .join("plugin/plugin/btmux.lua")
            .is_file());
        shutdown().await;
        assert!(matches!(*state.borrow(), State::Exited(_)));
    }

    #[test]
    fn parses_nvim_versions() {
        assert_eq!(
            parse_version("NVIM v0.12.5\nBuild type: Release"),
            Some((0, 12))
        );
        assert_eq!(parse_version("NVIM v0.13.0-dev-123+gabc"), Some((0, 13)));
        assert_eq!(parse_version("NVIM v1.0-dev"), Some((1, 0)));
        assert_eq!(parse_version("VIM - Vi IMproved 9.1"), None);
        assert!(parse_version("NVIM v0.11.4").unwrap() < MIN_VERSION);
    }

    #[test]
    fn runtime_directory_is_private_and_removed_on_drop() {
        let dir = PrivateDir::new().unwrap();
        let path = dir.0.clone();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::write(path.join("test"), "private").unwrap();
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn runtime_directory_rejects_existing_directories_and_symlinks() {
        let dir = PrivateDir::new().unwrap();
        let existing = dir.0.join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::write(existing.join("sentinel"), "untouched").unwrap();
        assert!(PrivateDir::create(existing.clone()).is_err());
        let link = dir.0.join("link");
        symlink(&existing, &link).unwrap();
        assert!(PrivateDir::create(link).is_err());
        assert_eq!(
            std::fs::read_to_string(existing.join("sentinel")).unwrap(),
            "untouched"
        );
    }
}
