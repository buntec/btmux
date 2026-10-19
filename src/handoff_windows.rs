//! In-place upgrades need `execve` and inheritable PTY masters; Windows has
//! neither, so `btmux upgrade` is refused there and a restart is required.

use crate::AppState;
use std::path::PathBuf;

/// No handoff file format.
pub const VERSION: u32 = 0;

const UNSUPPORTED: &str = "in-place upgrades are not supported on Windows; restart btmux";

/// Why an upgrade didn't start.
pub enum Refusal {
    /// Only a restart can move the server to the new binary.
    Incompatible(String),
    #[allow(dead_code)]
    Busy(String),
}

/// State inherited from a server that re-executed into this one: none.
pub enum Inherited {}

impl Inherited {
    pub fn take_lock(&mut self) -> Option<crate::persistence::ProfileLock> {
        match *self {}
    }

    pub async fn restore(self, _state: &AppState) -> std::net::TcpListener {
        match self {}
    }
}

pub fn take() -> Result<Option<Inherited>, String> {
    Ok(None)
}

pub async fn upgrade(_state: AppState, _exe: PathBuf) -> Result<(), Refusal> {
    Err(Refusal::Incompatible(UNSUPPORTED.into()))
}

pub fn last_error() -> Option<String> {
    None
}

/// `btmux upgrade`.
pub async fn run_cli(_profile: Option<&str>) -> i32 {
    eprintln!("btmux: {UNSUPPORTED}");
    // The server keeps running unchanged.
    3
}
