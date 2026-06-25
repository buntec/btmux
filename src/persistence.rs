//! On-disk persistence of the session tree so structure survives a server
//! restart. We serialize the same `SessionSnapshot`s broadcast to the browser
//! (session/window/pane tree, layout + split ratios, names, active indices, and
//! each pane's last-known cwd). Live process state and scrollback cannot be
//! restored — restored panes get a fresh shell, spawned lazily in their saved
//! cwd (see `SessionManager::restore_from_snapshots`).
//!
//! The state file lives under `$XDG_STATE_HOME/btmux/state.json` (falling back
//! to `$HOME/.local/state/btmux/state.json`) — deliberately *not* in the config
//! dir, which `main.rs` watches for live config reloads; writing there on every
//! mutation would spuriously trigger a reload.

use std::path::{Path, PathBuf};

use crate::session::manager::SessionSnapshot;

/// Resolve the XDG state base dir: `$XDG_STATE_HOME/btmux/`, falling back to
/// `$HOME/.local/state/btmux/`. Returns `None` when neither env var is set.
fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state"))
        })?;
    Some(base.join("btmux"))
}

/// Resolve the state file path: `$XDG_STATE_HOME/btmux/state.json`, falling back
/// to `$HOME/.local/state/btmux/state.json`. Returns `None` when neither env var
/// is set (persistence is then disabled).
pub fn state_path() -> Option<PathBuf> {
    state_dir().map(|d| d.join("state.json"))
}

/// Resolve the log directory: `$XDG_STATE_HOME/btmux/log/`.
pub fn log_dir() -> Option<PathBuf> {
    state_dir().map(|d| {
        let dir = d.join("log");
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

/// Load and parse saved snapshots. Returns `None` if the file is absent or
/// unreadable/corrupt — the caller then starts with a fresh default session.
pub fn load(path: &Path) -> Option<Vec<SessionSnapshot>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!("could not read state file {}: {}", path.display(), e);
            return None;
        }
    };
    match serde_json::from_str::<Vec<SessionSnapshot>>(&contents) {
        Ok(snaps) => Some(snaps),
        Err(e) => {
            tracing::warn!("ignoring corrupt state file {}: {}", path.display(), e);
            None
        }
    }
}

/// Write snapshots to disk atomically (write to a sibling temp file, then
/// rename) so a crash mid-write can't leave a truncated, unparseable file.
pub fn save(path: &Path, snapshots: &[SessionSnapshot]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(snapshots).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}
