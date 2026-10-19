//! In-place upgrade (`btmux upgrade`): the server re-executes a new binary in
//! its own process. PTY masters, the listener, and the profile lock stay open
//! across `execve`, and shells remain its children, so they keep running.
//! Sessions and replay journals pass through an unlinked file. If the exec
//! fails, the stopped PTY readers and writers restart.

use std::fs::File;
use std::io::{BufReader, Read, Seek, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::body::Bytes;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::pty::replay::Output;
use crate::pty::{set_cloexec, Handoff};
use crate::session::manager::SessionSnapshot;
use crate::session::NotificationLevel;
use crate::ws::control::ServerMessage;
use crate::AppState;

/// Bump on any change to the handoff file.
pub const VERSION: u32 = 2;
const ENV: &str = "BTMUX_HANDOFF";

struct Context {
    listener: RawFd,
    lock: Option<RawFd>,
    state_file: Option<PathBuf>,
}

static CONTEXT: OnceLock<Context> = OnceLock::new();
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Descriptors to keep across an upgrade, besides PTY masters.
pub fn configure(listener: RawFd, lock: Option<RawFd>, state_file: Option<PathBuf>) {
    let _ = CONTEXT.set(Context {
        listener,
        lock,
        state_file,
    });
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
struct Header {
    version: u32,
    listener: RawFd,
    lock: Option<RawFd>,
    sessions: Vec<SessionSnapshot>,
    panes: Vec<PaneHeader>,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
struct PaneHeader {
    id: Uuid,
    fd: RawFd,
    pid: libc::pid_t,
    cols: u16,
    rows: u16,
    /// Data events hold their length; the bytes follow the header in order.
    journal: Vec<Event>,
    title: Option<String>,
    cwd: Option<String>,
    spawn_cwd: Option<PathBuf>,
    color_reports: bool,
    colors: Vec<Option<[u8; 3]>>,
    /// Length of the partly read escape sequence, which follows the journal bytes.
    pending: usize,
    /// Length of the unwritten input, which follows the pending bytes.
    input: usize,
    bin: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
enum Event {
    Data(usize),
    Size(u16, u16),
}

/// What the previous server handed over.
pub struct Inherited {
    pub listener: std::net::TcpListener,
    pub lock: Option<OwnedFd>,
    pub sessions: Vec<SessionSnapshot>,
    pub panes: Vec<(Uuid, OwnedFd, Handoff)>,
}

/// Take over the previous server's state, if this process is an upgrade.
impl Inherited {
    pub fn take_lock(&mut self) -> Option<crate::persistence::ProfileLock> {
        self.lock.take().map(crate::persistence::ProfileLock::adopt)
    }

    /// Restore the sessions and panes; the listener is returned.
    pub async fn restore(self, state: &AppState) -> std::net::TcpListener {
        let mut mgr = state.write().await;
        let restored = mgr.restore_handoff(self.sessions, self.panes);
        tracing::info!("upgraded in place with {} session(s)", restored);
        self.listener
    }
}

pub fn take() -> Result<Option<Inherited>, String> {
    let Some(value) = std::env::var_os(ENV) else {
        return Ok(None);
    };
    // Before anything spawns, so shells don't inherit it.
    std::env::remove_var(ENV);
    let fd: RawFd = value
        .to_str()
        .and_then(|value| value.parse().ok())
        .ok_or("invalid handoff descriptor")?;
    let mut file = BufReader::new(unsafe { File::from_raw_fd(fd) });
    let error = |e: std::io::Error| format!("cannot read handoff: {e}");
    let mut len = [0; 8];
    file.read_exact(&mut len).map_err(error)?;
    let mut header = vec![0; u64::from_le_bytes(len) as usize];
    file.read_exact(&mut header).map_err(error)?;
    let header: Header =
        serde_json::from_slice(&header).map_err(|e| format!("cannot read handoff: {e}"))?;
    if header.version != VERSION {
        return Err(format!("unsupported handoff version {}", header.version));
    }
    let listener = unsafe { std::net::TcpListener::from_raw_fd(header.listener) };
    set_cloexec(header.listener, true).map_err(error)?;
    let lock = header.lock.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) });
    if let Some(lock) = &lock {
        set_cloexec(lock.as_raw_fd(), true).map_err(error)?;
    }
    let masters: Vec<OwnedFd> = header
        .panes
        .iter()
        .map(|pane| unsafe { OwnedFd::from_raw_fd(pane.fd) })
        .collect();
    // Startup runs programs (`nvim --version`) before the shells are adopted.
    for master in &masters {
        set_cloexec(master.as_raw_fd(), true).map_err(error)?;
    }
    let mut panes = Vec::new();
    for (pane, master) in header.panes.into_iter().zip(masters) {
        let mut journal = Vec::with_capacity(pane.journal.len());
        for event in pane.journal {
            journal.push(match event {
                Event::Size(cols, rows) => Output::Size(cols, rows),
                Event::Data(len) => {
                    let mut bytes = vec![0; len];
                    file.read_exact(&mut bytes).map_err(error)?;
                    Output::Data(Bytes::from(bytes))
                }
            });
        }
        let mut pending = vec![0; pane.pending];
        file.read_exact(&mut pending).map_err(error)?;
        let mut input = vec![0; pane.input];
        file.read_exact(&mut input).map_err(error)?;
        panes.push((
            pane.id,
            master,
            Handoff {
                pid: pane.pid,
                cols: pane.cols,
                rows: pane.rows,
                journal,
                title: pane.title,
                cwd: pane.cwd,
                spawn_cwd: pane.spawn_cwd,
                color_reports: pane.color_reports,
                colors: pane.colors,
                pending,
                input,
                bin: pane.bin,
            },
        ));
    }
    Ok(Some(Inherited {
        listener,
        lock,
        sessions: header.sessions,
        panes,
    }))
}

/// Why an upgrade didn't start.
pub enum Refusal {
    /// Only a restart can move the server to the new binary.
    Incompatible(String),
    /// Retry later, e.g. once Neovim's buffers are saved.
    Busy(String),
}

/// Check that `exe` accepts this server's handoff, then re-execute into it
/// once the caller has replied.
pub async fn upgrade(state: AppState, exe: PathBuf) -> Result<(), Refusal> {
    let (context, target) = match check(&exe).await {
        Ok(checked) => checked,
        Err(refusal) => {
            let message = match &refusal {
                Refusal::Incompatible(error) => format!("Upgrade refused: {error}"),
                Refusal::Busy(error) => {
                    format!("Upgrade postponed: {error}. Run btmux upgrade to retry.")
                }
            };
            toast(&state, message, NotificationLevel::Attention).await;
            return Err(refusal);
        }
    };
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err(Refusal::Busy("an upgrade is already in progress".into()));
    }
    *LAST_ERROR.lock().unwrap() = None;
    let message = format!("Upgrading btmux to {target}…");
    toast(&state, message, NotificationLevel::Info).await;
    tokio::spawn(async move {
        // Let the reply and toast reach their clients.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let error = execute(state.clone(), context, &exe).await;
        tracing::error!("in-place upgrade failed: {error}");
        let message = format!("Upgrade failed: {error}");
        toast(&state, message, NotificationLevel::Error).await;
        *LAST_ERROR.lock().unwrap() = Some(error);
        IN_PROGRESS.store(false, Ordering::SeqCst);
    });
    Ok(())
}

async fn toast(state: &AppState, message: String, level: NotificationLevel) {
    let toast = ServerMessage::Toast { message, level };
    let _ = state
        .read()
        .await
        .events()
        .send(serde_json::to_string(&toast).unwrap());
}

/// The upgrade's context and `exe`'s version, if it can take over.
async fn check(exe: &Path) -> Result<(&'static Context, String), Refusal> {
    let context = CONTEXT
        .get()
        .ok_or_else(|| Refusal::Incompatible("this server cannot upgrade in place".into()))?;
    if !exe.is_absolute() || !exe.is_file() {
        return Err(Refusal::Incompatible(format!(
            "{} is not an executable file",
            exe.display()
        )));
    }
    let incompatible = Refusal::Incompatible;
    // With this server's arguments, which `exec` passes on.
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(exe)
            .args(std::env::args_os().skip(1))
            .arg("handoff-version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| incompatible(format!("{} did not respond", exe.display())))?
    .map_err(|e| incompatible(format!("cannot run {}: {e}", exe.display())))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().next().unwrap_or_default();
        let reason = reason.trim().trim_start_matches("error: ");
        return Err(incompatible(format!(
            "{} cannot take over this server ({reason}); restart it instead",
            exe.display()
        )));
    }
    // `<handoff version> <btmux version>`
    let version = String::from_utf8_lossy(&output.stdout);
    let mut version = version.split_whitespace();
    if version.next() != Some(&VERSION.to_string()) {
        return Err(incompatible(format!(
            "{} cannot take over this server (handoff version {VERSION}); restart it instead",
            exe.display()
        )));
    }
    let target = version.next().unwrap_or("?").to_string();
    crate::ws::nvim::check_saved()
        .await
        .map_err(Refusal::Busy)?;
    Ok((context, target))
}

/// Why the last upgrade failed, for `btmux upgrade`.
pub fn last_error() -> Option<String> {
    LAST_ERROR.lock().unwrap().clone()
}

/// Only returns on failure, with the shells running again.
async fn execute(state: AppState, context: &Context, exe: &Path) -> String {
    tracing::info!("upgrading in place to {}", exe.display());
    // Held until exec, so nothing changes or spawns meanwhile.
    let mut manager = state.write().await;
    // Before anything stops: Neovim refuses to quit with unsaved changes.
    if let Err(error) = crate::ws::nvim::quit().await {
        return error;
    }
    crate::vscode::shutdown().await;
    let (sessions, panes) = match manager.export_handoff(Duration::from_secs(2)) {
        Ok(exported) => exported,
        Err(error) => return error,
    };
    if let Some(path) = &context.state_file {
        if let Err(error) = crate::persistence::save(path, &sessions) {
            tracing::warn!("failed to persist state to {}: {}", path.display(), error);
        }
    }
    let error = exec(context, exe, sessions, &panes);
    let kept = [context.listener]
        .into_iter()
        .chain(context.lock)
        .chain(panes.iter().map(|(_, fd, _)| *fd));
    for fd in kept {
        let _ = set_cloexec(fd, true);
    }
    manager.resume_handoff(panes);
    error
}

/// Only returns on failure.
fn exec(
    context: &Context,
    exe: &Path,
    sessions: Vec<SessionSnapshot>,
    panes: &[(Uuid, RawFd, Handoff)],
) -> String {
    let dir = context
        .state_file
        .as_deref()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let file = match write(&dir, context, sessions, panes) {
        Ok(file) => file,
        Err(error) => return format!("cannot write handoff: {error}"),
    };
    let inherited = [file.as_raw_fd(), context.listener]
        .into_iter()
        .chain(context.lock)
        .chain(panes.iter().map(|(_, fd, _)| *fd));
    for fd in inherited {
        if let Err(error) = set_cloexec(fd, false) {
            return format!("cannot pass descriptor {fd}: {error}");
        }
    }
    let error = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env(ENV, file.as_raw_fd().to_string())
        .exec();
    format!("cannot execute {}: {error}", exe.display())
}

/// An unlinked, owner-only file holding the header and journal bytes.
fn write(
    dir: &Path,
    context: &Context,
    sessions: Vec<SessionSnapshot>,
    panes: &[(Uuid, RawFd, Handoff)],
) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = dir.join(format!(".handoff-{}", Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    std::fs::remove_file(&path)?;
    let header = Header {
        version: VERSION,
        listener: context.listener,
        lock: context.lock,
        sessions,
        panes: panes
            .iter()
            .map(|(id, fd, pane)| PaneHeader {
                id: *id,
                fd: *fd,
                pid: pane.pid,
                cols: pane.cols,
                rows: pane.rows,
                journal: pane
                    .journal
                    .iter()
                    .map(|event| match event {
                        Output::Data(bytes) => Event::Data(bytes.len()),
                        Output::Size(cols, rows) => Event::Size(*cols, *rows),
                    })
                    .collect(),
                title: pane.title.clone(),
                cwd: pane.cwd.clone(),
                spawn_cwd: pane.spawn_cwd.clone(),
                color_reports: pane.color_reports,
                colors: pane.colors.clone(),
                pending: pane.pending.len(),
                input: pane.input.len(),
                bin: pane.bin.clone(),
            })
            .collect(),
    };
    let header = serde_json::to_vec(&header)?;
    let mut out = std::io::BufWriter::new(&mut file);
    out.write_all(&(header.len() as u64).to_le_bytes())?;
    out.write_all(&header)?;
    for (_, _, pane) in panes {
        for event in &pane.journal {
            if let Output::Data(bytes) = event {
                out.write_all(bytes)?;
            }
        }
        out.write_all(&pane.pending)?;
        out.write_all(&pane.input)?;
    }
    out.flush()?;
    drop(out);
    file.rewind()?;
    Ok(file)
}

/// `btmux upgrade` exit status when the server keeps running unchanged.
const KEPT: i32 = 3;

/// `btmux upgrade`: move the profile's server to this binary.
pub async fn run_cli(profile: Option<&str>) -> i32 {
    match upgrade_server(profile).await {
        Ok(version) => {
            println!("btmux server upgraded to {version}");
            0
        }
        Err((code, error)) => {
            eprintln!("btmux: {error}");
            code
        }
    }
}

async fn upgrade_server(profile: Option<&str>) -> Result<String, (i32, String)> {
    let failed = |error: String| (1, error);
    let state = crate::persistence::state_path(profile)
        .map_err(failed)?
        .ok_or_else(|| failed("cannot resolve the btmux state directory".into()))?;
    let server = crate::discovery::read_registration(&state.with_extension("server"))
        .ok_or_else(|| failed("no running btmux server found".into()))?;
    let url = format!("http://{}", server.address);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| failed(e.to_string()))?;
    let info = || async {
        client
            .get(format!("{url}/api/info"))
            .bearer_auth(&server.token)
            .send()
            .await
            .ok()?
            .bytes()
            .await
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
    };
    let before = info()
        .await
        .ok_or_else(|| failed("cannot reach the btmux server".into()))?;
    let exe = std::env::current_exe().map_err(|e| failed(e.to_string()))?;
    let response = client
        .post(format!("{url}/api/server/upgrade"))
        .bearer_auth(&server.token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "executable": exe }).to_string())
        .send()
        .await
        .map_err(|e| failed(e.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let code = if status == reqwest::StatusCode::LOCKED {
            KEPT
        } else {
            1
        };
        return Err((
            code,
            if body.is_empty() {
                format!("upgrade refused: {status}")
            } else {
                body
            },
        ));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(info) = info().await {
            if info["instance"] != before["instance"] {
                // An exec keeps the pid; a service manager's restart doesn't.
                if info["pid"] != before["pid"] {
                    return Err(failed(
                        "the server restarted instead of upgrading in place; its shells were lost"
                            .into(),
                    ));
                }
                return Ok(info["version"].as_str().unwrap_or("?").to_string());
            }
            if let Some(error) = info["upgrade_error"].as_str() {
                return Err((KEPT, format!("upgrade failed: {error}")));
            }
        }
    }
    Err(failed("timed out waiting for the upgraded server".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::TS;

    /// A change to the handoff file's shape needs a new `VERSION`, or the old
    /// server execs a binary that can't read its handoff.
    #[test]
    fn format_changes_bump_the_version() {
        use crate::session::{
            layout::Layout, manager::WindowSnapshot, AgentState, AgentStatus, NotificationLevel,
            PaneAlert, PaneSnapshot,
        };
        let config = ts_rs::Config::default();
        let schema = [
            Header::decl(&config),
            PaneHeader::decl(&config),
            Event::decl(&config),
            SessionSnapshot::decl(&config),
            WindowSnapshot::decl(&config),
            PaneSnapshot::decl(&config),
            PaneAlert::decl(&config),
            AgentStatus::decl(&config),
            AgentState::decl(&config),
            NotificationLevel::decl(&config),
            Layout::decl(&config),
        ]
        .join("\n");
        // Without doc comments.
        let mut shape = String::new();
        let mut rest = schema.as_str();
        while let Some((before, after)) = rest.split_once("/**") {
            shape.push_str(before);
            rest = after.split_once("*/").map_or("", |(_, after)| after);
        }
        shape.push_str(rest);
        let shape: Vec<_> = shape
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let output = format!("// handoff version {VERSION}\n{}\n", shape.join("\n"));
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/handoff.schema");
        let recorded = std::fs::read_to_string(&path).unwrap_or_default();
        if recorded == output {
            return;
        }
        let recorded_version: u32 = recorded
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("// handoff version "))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        assert!(
            VERSION > recorded_version,
            "The handoff format changed: bump handoff::VERSION, then run just protocol"
        );
        assert!(
            std::env::var_os("BTMUX_UPDATE_PROTOCOL").is_some(),
            "Run just protocol to record handoff version {VERSION}"
        );
        std::fs::write(&path, output).unwrap();
    }
}
