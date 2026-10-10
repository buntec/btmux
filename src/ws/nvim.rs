//! `/ws/nvim`: the built-in Neovim UI. One shared headless Neovim per server;
//! each socket is a separate msgpack-RPC connection that attaches its own UI.

use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

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
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static SERVER: LazyLock<Mutex<Option<NvimServer>>> = LazyLock::new(|| Mutex::new(None));

struct NvimServer {
    child: Child,
    directory: PrivateDir,
}

struct PrivateDir(PathBuf);

impl PrivateDir {
    fn new() -> Result<Self, String> {
        Self::create(std::env::temp_dir().join(format!("btmux-{}", uuid::Uuid::new_v4().simple())))
    }

    fn create(path: PathBuf) -> Result<Self, String> {
        // Atomic creation rejects existing directories and symlinks.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|e| format!("create {}: {e}", path.display()))?;
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

/// Spawn the shared Neovim if it isn't running, then connect to it.
async fn connect() -> Result<(UnixStream, PathBuf), String> {
    let mut server = SERVER.lock().await;
    let running = match server.as_mut() {
        Some(server) => matches!(server.child.try_wait(), Ok(None)),
        None => false,
    };
    if !running {
        let directory = PrivateDir::new()?;
        let path = directory.0.join("nvim.sock");
        let plugin = directory.0.join("plugin");
        install_plugin(&plugin)?;
        // A JSON string is a valid Lua string literal for any path.
        let plugin = serde_json::to_string(&plugin.to_string_lossy()).unwrap();
        // `--embed` ties Neovim's lifetime to our stdin pipe; `--headless`
        // keeps it from waiting for a UI on stdio. `g:btmux` lets user config
        // adapt (e.g. skip scroll animation plugins); the plugin is on
        // 'runtimepath' before user config so it can `require("btmux")`.
        let mut child = Command::new("nvim")
            .args(["--embed", "--headless", "--cmd", "let g:btmux = 1", "--cmd"])
            .arg(format!("lua vim.opt.rtp:prepend({plugin})"))
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
        *server = Some(NvimServer { child, directory });
    }
    let path = server.as_ref().unwrap().directory.0.join("nvim.sock");
    drop(server);

    let mut last_error = String::new();
    for _ in 0..50 {
        match UnixStream::connect(&path).await {
            Ok(stream) => return Ok((stream, path)),
            Err(e) => last_error = e.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
    Err(format!("connect to nvim: {last_error}"))
}

/// Open `path` in the shared Neovim, starting it if needed.
pub async fn open(path: &str, line: Option<u32>) -> Result<(), String> {
    let (stream, addr) = connect().await?;
    drop(stream);
    super::control::remote_open_in_editor(&addr.to_string_lossy(), path, line)
        .await
        .map_err(|()| "Neovim did not open the file".into())
}

pub async fn shutdown() {
    if let Some(mut server) = SERVER.lock().await.take() {
        let _ = server.child.kill().await;
    }
}

pub async fn handle(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let stream = match connect().await {
        Ok((stream, _)) => stream,
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
                // Neovim closed the channel, i.e. it quit: tell the UI to close.
                Ok(0) | Err(_) => {
                    let frame = CloseFrame {
                        code: close_code::NORMAL,
                        reason: "Neovim exited".into(),
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
