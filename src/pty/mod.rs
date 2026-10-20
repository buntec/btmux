pub mod colors;
pub mod replay;
pub mod screen;
#[cfg(unix)]
mod unix;
#[allow(dead_code)]
pub mod vt_query;
#[cfg(windows)]
mod windows;
use axum::body::Bytes;
use replay::{Output, Replay};

pub use crate::process::Pid;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
#[cfg(unix)]
use unix::{foreground, resize_master, Master, Probe, Stopping};
#[cfg(unix)]
pub use unix::{hang_up, set_cloexec, Handoff};
use uuid::Uuid;
#[cfg(windows)]
use windows::{foreground, resize_master, Master, Probe};

/// Largest single write to a PTY's input queue.
pub const MAX_INPUT: usize = 64 * 1024;

/// This server's binary, read at startup: once it is replaced on disk, Linux
/// reports `<path> (deleted)`.
pub fn server_exe() -> Option<&'static Path> {
    static EXE: LazyLock<Option<PathBuf>> = LazyLock::new(|| std::env::current_exe().ok());
    EXE.as_deref()
}

/// Server-wide context shared by every PTY.
#[derive(Clone)]
pub struct PtyEnv {
    /// Notifies the session manager that a shell exited so its pane can be removed.
    pub exit_tx: mpsc::UnboundedSender<Uuid>,
    /// Notifies the session manager that OSC title/cwd changed.
    pub meta_tx: mpsc::UnboundedSender<()>,
    /// Server port, injected as BTMUX_API_URL into the shell environment.
    pub port: u16,
    /// Theme colors reported to programs in the PTY.
    pub palette: colors::SharedPalette,
}

#[derive(Clone)]
pub struct InputSender(mpsc::Sender<PtyInput>);

enum PtyInput {
    Raw(Vec<u8>),
    ShellCommand {
        data: Vec<u8>,
        shell_pid: Pid,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Wakes an idle writer for a handoff.
    #[cfg(unix)]
    Stop,
}

impl InputSender {
    pub async fn send_wait(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > MAX_INPUT {
            return Err("PTY input exceeds 64 KiB".into());
        }
        self.0
            .send(PtyInput::Raw(data))
            .await
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }
    pub fn send(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > MAX_INPUT {
            return Err("PTY input exceeds 64 KiB; split it into smaller requests".into());
        }
        self.0
            .try_send(PtyInput::Raw(data))
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }

    async fn send_shell_command(&self, data: Vec<u8>, shell_pid: Pid) -> Result<(), String> {
        if data.len() > MAX_INPUT {
            return Err("PTY input exceeds 64 KiB".into());
        }
        let (reply, result) = oneshot::channel();
        self.0
            .send(PtyInput::ShellCommand {
                data,
                shell_pid,
                reply,
            })
            .await
            .map_err(|e| format!("PTY input unavailable: {e}"))?;
        result
            .await
            .map_err(|_| "PTY input unavailable".to_string())?
    }
}

pub struct PtyHandle {
    pub input_tx: InputSender,
    output_tx: broadcast::Sender<Output>,
    scrollback: Arc<Mutex<Replay>>,
    /// The shell's pid until it is reaped.
    child: Arc<Mutex<Option<Pid>>>,
    master: Option<Master>,
    /// Write end of the pipe that stops the reader.
    #[cfg(unix)]
    stop_reader: Option<std::os::fd::OwnedFd>,
    #[cfg(unix)]
    stopping: Mutex<Option<Stopping>>,
    /// The `BTMUX_BIN` the shell was started with.
    bin: Option<std::path::PathBuf>,
    viewers: Vec<(Uuid, u16, u16)>,
    /// The interactive viewer whose size the PTY follows.
    owner_tx: watch::Sender<Option<Uuid>>,
    size: Arc<Mutex<(u16, u16)>>,
    spawned: Arc<Mutex<bool>>,
    shell_pid: Option<Pid>,
    shell: String,
    dialect: crate::shell::Dialect,
    /// OSC 133 marks: 0 before the first, odd at a prompt, `2n` while
    /// command `n` runs.
    prompt: Arc<AtomicU32>,
    /// Initial working directory for the shell process.
    spawn_cwd: Option<std::path::PathBuf>,
    /// Id of the pane owning this PTY, reported on `exit_tx` when the shell dies.
    pane_id: Uuid,
    /// Notifies the session manager that the shell exited (EOF on the master) so
    /// the pane can be removed.
    exit_tx: mpsc::UnboundedSender<Uuid>,
    /// Notifies the session manager that OSC title/cwd changed so it can re-broadcast state.
    meta_tx: mpsc::UnboundedSender<()>,
    /// Foreground pgroup at the time each DSR 6 query was forwarded. When a
    /// CPR response arrives, pop the front: if tcgetpgrp(master) differs, the
    /// requester died and the response is stale.
    pending_cpr_pgrps: Arc<Mutex<VecDeque<Pid>>>,
    /// Finds the foreground process group; invalidated under this mutex on drop.
    probe: Arc<Mutex<Option<Probe>>>,
    /// Last OSC 0/2 title emitted by the shell.
    pub title: Arc<Mutex<Option<String>>>,
    /// The shell's working directory: its last OSC 7, or on Unix, from the OS.
    pub cwd: Arc<Mutex<Option<String>>>,
    /// Server port, injected as BTMUX_API_URL into the shell environment.
    port: u16,
    /// Maximum backend replay buffer size in bytes, derived from the config's
    /// scrollback line count. Controls how much PTY output is kept for replay
    /// on reconnect; the browser emulator's scrollback uses the line count directly.
    scrollback_bytes: usize,
    palette: colors::SharedPalette,
    /// Mode 2031, set by the program in the PTY.
    color_reports: Arc<AtomicBool>,
}

impl PtyHandle {
    pub fn new_with_cwd(
        shell: &str,
        pane_id: Uuid,
        env: &PtyEnv,
        spawn_cwd: Option<std::path::PathBuf>,
        scrollback_lines: u32,
    ) -> Self {
        let (input_tx, _) = mpsc::channel::<PtyInput>(32);
        let (output_tx, _) = broadcast::channel::<Output>(256);

        Self {
            input_tx: InputSender(input_tx),
            output_tx,
            scrollback: Arc::new(Mutex::new(Replay::new(
                80,
                24,
                scrollback_lines as usize * 1000,
            ))),
            child: Arc::new(Mutex::new(None)),
            master: None,
            #[cfg(unix)]
            stop_reader: None,
            #[cfg(unix)]
            stopping: Mutex::new(None),
            bin: None,
            viewers: Vec::new(),
            owner_tx: watch::channel(None).0,
            size: Arc::new(Mutex::new((0, 0))),
            spawned: Arc::new(Mutex::new(false)),
            shell_pid: None,
            shell: shell.to_string(),
            dialect: crate::shell::Dialect::of(shell),
            prompt: Arc::default(),
            spawn_cwd,
            pane_id,
            exit_tx: env.exit_tx.clone(),
            meta_tx: env.meta_tx.clone(),
            pending_cpr_pgrps: Arc::new(Mutex::new(VecDeque::new())),
            probe: Arc::new(Mutex::new(None)),
            title: Arc::new(Mutex::new(None)),
            cwd: Arc::new(Mutex::new(None)),
            port: env.port,
            scrollback_bytes: scrollback_lines as usize * 1000,
            palette: env.palette.clone(),
            color_reports: Arc::default(),
        }
    }

    /// Best-known working directory for snapshots: the live OSC 7 cwd if the
    /// shell has reported one, otherwise the directory the shell was spawned in.
    /// Without the fallback, a pane whose shell was never attached (lazily
    /// spawned) — e.g. sessions created by `create-session-from-git-repos` and
    /// never viewed — would persist a null cwd and lose it across restarts.
    pub fn effective_cwd(&self) -> Option<String> {
        if let Some(cwd) = self.cwd.lock().unwrap().clone() {
            return Some(cwd);
        }
        self.spawn_cwd
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
    }

    pub fn screen_revision(&self) -> u64 {
        self.scrollback.lock().unwrap().screen_revision()
    }

    pub fn screen_snapshot(&self) -> Option<screen::ScreenSnapshot> {
        self.scrollback.lock().unwrap().screen_snapshot()
    }

    /// The checkpoint and journal, as replayed to a new viewer.
    pub fn journal(&self) -> Vec<Output> {
        self.scrollback.lock().unwrap().snapshot()
    }

    pub fn track_screen(&self, enabled: bool) {
        self.scrollback.lock().unwrap().track_screen(enabled);
    }

    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid.and_then(|pid| pid.try_into().ok())
    }

    pub fn foreground_pgrp(&self) -> Option<Pid> {
        self.probe.lock().unwrap().as_ref().and_then(foreground)
    }

    pub fn ensure_spawned(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        {
            let spawned = self.spawned.lock().unwrap();
            if *spawned {
                return Ok(());
            }
        }

        // Prepare all fallible resources before starting worker threads. The PTY
        // kernel buffer retains initial shell output until the reader starts.
        let argv = crate::shell::argv(&self.shell);
        let (program, args) = argv.split_first().ok_or("no shell configured")?;
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("BTMUX_PANE_ID", self.pane_id.to_string());
        self.bin = server_exe().map(Path::to_path_buf);
        if let Some(exe) = &self.bin {
            cmd.env("BTMUX_BIN", exe);
        }
        if let Some(token) = crate::auth::shell_token() {
            cmd.env("BTMUX_AUTH_TOKEN", token);
        }
        cmd.env(
            "BTMUX_API_URL",
            format!("http://{}:{}", crate::config::DEFAULT_HOST, self.port),
        );
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if let Some(ref dir) = self.spawn_cwd {
            cmd.cwd(dir);
        }
        #[cfg(windows)]
        windows::integrate_shell(&mut cmd, self.dialect, self.spawn_cwd.is_none());

        self.spawn(cmd, cols, rows)
    }

    /// The program that runs `btmux` subcommands in this pane's shell: its
    /// `$BTMUX_BIN`, unless an upgrade replaced that binary.
    pub fn shell_bin(&self) -> String {
        let exe = server_exe().filter(|exe| self.bin.as_deref() != Some(*exe));
        self.dialect
            .btmux(exe.map(|exe| exe.to_string_lossy()).as_deref())
    }

    pub fn dialect(&self) -> crate::shell::Dialect {
        self.dialect
    }

    /// Tell a program that enabled mode 2031 that the theme changed.
    pub fn report_color_scheme(&self, palette: &colors::Palette) {
        if self.is_spawned() && self.color_reports.load(Ordering::Relaxed) {
            let _ = self.input_tx.send(palette.scheme_report());
        }
    }

    pub async fn send_shell_command(&self, data: Vec<u8>) -> Result<(), String> {
        let shell_pid = self
            .shell_pid
            .ok_or_else(|| "The pane's shell is unavailable".to_string())?;
        self.input_tx.send_shell_command(data, shell_pid).await
    }

    /// Record the current foreground process group for a forwarded DSR 6 query.
    fn record_cpr_pgrp(probe: &Mutex<Option<Probe>>, pending_cpr_pgrps: &Mutex<VecDeque<Pid>>) {
        let pgrp = probe
            .lock()
            .unwrap()
            .as_ref()
            .and_then(foreground)
            .unwrap_or(-1);
        let mut pending = pending_cpr_pgrps.lock().unwrap();
        if pending.len() == 256 {
            pending.pop_front();
        }
        pending.push_back(pgrp);
    }

    /// Filter CPR responses (`ESC[row;colR`) from emulator input. A response
    /// is valid only if (a) a pending DSR 6 was recorded AND (b) the foreground
    /// pgroup hasn't changed since the query was sent. If the pgroup differs,
    /// the requester exited (e.g. Ctrl-C killed the app) and writing the
    /// response would echo garbage to the new foreground (the shell).
    fn filter_stale_cpr(
        data: &[u8],
        pending_cpr_pgrps: &Mutex<VecDeque<Pid>>,
        probe: &Mutex<Option<Probe>>,
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0x1b && i + 2 < data.len() && data[i + 1] == b'[' {
                let start = i + 2;
                let mut end = start;
                while end < data.len() && (data[end].is_ascii_digit() || data[end] == b';') {
                    end += 1;
                }
                // CPR: ESC[row;colR (final byte 'R')
                if end < data.len() && data[end] == b'R' {
                    let params = &data[start..end];
                    if params.contains(&b';') {
                        let recorded_pgrp = pending_cpr_pgrps.lock().unwrap().pop_front();
                        if let Some(pgrp) = recorded_pgrp {
                            let current_pgrp = probe
                                .lock()
                                .unwrap()
                                .as_ref()
                                .and_then(foreground)
                                .unwrap_or(-1);
                            if pgrp == current_pgrp {
                                out.extend_from_slice(&data[i..end + 1]);
                            }
                            // else: pgrp changed → requester dead → drop
                        }
                        // else: no pending query → unsolicited → drop
                        i = end + 1;
                        continue;
                    }
                }
            }
            out.push(data[i]);
            i += 1;
        }
        out
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if validate_size(cols, rows).is_err() {
            return;
        }
        let mut size = self.size.lock().unwrap();
        if *size != (cols, rows) {
            *size = (cols, rows);
            drop(size);
            let mut replay = self.scrollback.lock().unwrap();
            replay.push(Output::Size(cols, rows));
            let _ = self.output_tx.send(Output::Size(cols, rows));
            if let Some(master) = &self.master {
                resize_master(master, cols, rows);
            }
        }
    }

    pub fn is_spawned(&self) -> bool {
        *self.spawned.lock().unwrap()
    }

    /// Subscribe to live output and snapshot the scrollback buffer atomically.
    /// Holding the scrollback lock while subscribing ensures the reader thread
    /// cannot append-then-broadcast a chunk between the two operations, which
    /// would cause that chunk to appear in both the replay and the live stream.
    pub fn subscribe_and_get_scrollback(&self) -> (broadcast::Receiver<Output>, Vec<u8>) {
        let replay = self.scrollback.lock().unwrap();
        let snapshot = replay
            .snapshot()
            .into_iter()
            .filter_map(|event| match event {
                Output::Data(bytes) => Some(bytes),
                _ => None,
            })
            .flatten()
            .collect();
        (self.output_tx.subscribe(), snapshot)
    }

    pub fn subscribe_output(&self) -> broadcast::Receiver<Output> {
        self.output_tx.subscribe()
    }

    pub fn subscribe_replay(&self) -> (broadcast::Receiver<Output>, Vec<Output>) {
        let replay = self.scrollback.lock().unwrap();
        (self.output_tx.subscribe(), replay.snapshot())
    }

    // The first interactive viewer owns the shared PTY dimensions until it
    // disconnects or another viewer claims them. Followers receive ordered size
    // events; mirrors never acquire ownership.
    pub fn attach_viewer(&mut self, id: Uuid, cols: u16, rows: u16) {
        self.viewers.push((id, cols, rows));
        if self.viewers.len() == 1 {
            self.resize(cols, rows);
            self.publish_owner();
        }
    }
    /// Make a viewer the size owner, e.g. after user input in its tab.
    pub fn claim_viewer(&mut self, id: Uuid) {
        let Some(index) = self.viewers.iter().position(|v| v.0 == id) else {
            return;
        };
        if index == 0 {
            return;
        }
        let viewer = self.viewers.remove(index);
        self.viewers.insert(0, viewer);
        self.resize(viewer.1, viewer.2);
        self.publish_owner();
    }
    pub fn subscribe_owner(&self) -> watch::Receiver<Option<Uuid>> {
        self.owner_tx.subscribe()
    }
    fn publish_owner(&self) {
        self.owner_tx
            .send_replace(self.viewers.first().map(|v| v.0));
    }
    pub fn resize_viewer(&mut self, id: Uuid, cols: u16, rows: u16) {
        if validate_size(cols, rows).is_err() {
            return;
        }
        if let Some(viewer) = self.viewers.iter_mut().find(|v| v.0 == id) {
            *viewer = (id, cols, rows);
        }
        if self.viewers.first().is_some_and(|v| v.0 == id) {
            self.resize(cols, rows);
        }
    }
    pub fn detach_viewer(&mut self, id: Uuid) {
        self.viewers.retain(|v| v.0 != id);
        if let Some(&(_, cols, rows)) = self.viewers.first() {
            self.resize(cols, rows);
        }
        self.publish_owner();
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
        return Err("PTY size must be 1..500 columns and 1..200 rows".into());
    }
    Ok(())
}

/// Turns PTY output into replies, replay, and broadcast.
struct OutputPipeline {
    interceptor: vt_query::VtQueryInterceptor,
    osc_parser: OscParser,
    response_tx: mpsc::Sender<PtyInput>,
    pending_cpr_pgrps: Arc<Mutex<VecDeque<Pid>>>,
    probe: Arc<Mutex<Option<Probe>>>,
    title: Arc<Mutex<Option<String>>>,
    cwd: Arc<Mutex<Option<String>>>,
    scrollback: Arc<Mutex<Replay>>,
    output_tx: broadcast::Sender<Output>,
    pane_id: Uuid,
    /// The pane's shell and its name when the pipeline started.
    #[cfg(unix)]
    shell: Option<(Pid, String)>,
    /// The last foreground group polled for its cwd, and whether it's a shell.
    #[cfg(unix)]
    leader: Option<(Pid, bool)>,
}

impl PtyHandle {
    fn output_pipeline(
        &self,
        interceptor: vt_query::VtQueryInterceptor,
        response_tx: mpsc::Sender<PtyInput>,
    ) -> OutputPipeline {
        OutputPipeline {
            interceptor,
            osc_parser: OscParser::new(self.meta_tx.clone(), self.prompt.clone()),
            response_tx,
            pending_cpr_pgrps: self.pending_cpr_pgrps.clone(),
            probe: self.probe.clone(),
            title: self.title.clone(),
            cwd: self.cwd.clone(),
            scrollback: self.scrollback.clone(),
            output_tx: self.output_tx.clone(),
            pane_id: self.pane_id,
            #[cfg(unix)]
            shell: self
                .shell_pid
                .and_then(|pid| Some((pid, crate::process::name(pid)?))),
            #[cfg(unix)]
            leader: None,
        }
    }
}

impl OutputPipeline {
    /// `Err` holds the replies once the PTY input queue is closed.
    fn feed(&mut self, chunk: &[u8]) -> Result<(), Vec<u8>> {
        if chunk.is_empty() {
            return Ok(());
        }
        let pane_id = self.pane_id;
        let result = self.interceptor.feed(chunk);

        // One queue entry per chunk. A full queue drops the replies: blocking
        // here could deadlock against a program that is not reading its input.
        let responses = result.responses.concat();
        let mut sent = Ok(());
        if !responses.is_empty() {
            match self.response_tx.try_send(PtyInput::Raw(responses)) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    tracing::warn!(%pane_id, "PTY input queue full; dropped replies");
                }
                Err(mpsc::error::TrySendError::Closed(input)) => {
                    let PtyInput::Raw(responses) = input else {
                        unreachable!()
                    };
                    sent = Err(responses);
                }
            }
        }
        for _ in 0..result.forwarded_cpr_queries {
            PtyHandle::record_cpr_pgrp(&self.probe, &self.pending_cpr_pgrps);
        }

        self.osc_parser
            .feed(&result.scrollback, &self.title, &self.cwd);
        #[cfg(unix)]
        self.poll_cwd();
        let mut sb = self.scrollback.lock().unwrap();
        sb.push(Output::Data(Bytes::from(result.scrollback)));
        let _ = self
            .output_tx
            .send(Output::Data(Bytes::from(result.broadcast)));
        sent
    }
}

/// Record an OSC 133 prompt or command mark.
fn mark_prompt(state: &AtomicU32, command: bool) {
    let _ = state.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |state| {
        match (command, state % 2 == 1) {
            (true, false) if state == 0 => Some(2),
            (false, false) | (true, true) => Some(state + 1),
            _ => None,
        }
    });
}

/// Decode `%XX` escapes; malformed escapes and non-UTF-8 results stay raw.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
            .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Incremental OSC sequence parser. Handles sequences split across read() chunks.
/// Parses OSC 0/2 (window title), OSC 7 (working directory URI), and OSC 133
/// prompt (`A`) and command (`C`) marks.
struct OscParser {
    buf: Vec<u8>,
    in_osc: bool,
    /// An OSC 7 arrived; it then owns the cwd.
    reported_cwd: bool,
    meta_tx: mpsc::UnboundedSender<()>,
    prompt: Arc<AtomicU32>,
}

impl OscParser {
    fn new(meta_tx: mpsc::UnboundedSender<()>, prompt: Arc<AtomicU32>) -> Self {
        Self {
            buf: Vec::new(),
            in_osc: false,
            reported_cwd: false,
            meta_tx,
            prompt,
        }
    }

    fn feed(
        &mut self,
        data: &[u8],
        title: &Arc<Mutex<Option<String>>>,
        cwd: &Arc<Mutex<Option<String>>>,
    ) {
        for &b in data {
            if self.in_osc {
                // BEL (0x07) or ST (ESC \) terminates the sequence.
                if b == 0x07 {
                    self.dispatch(title, cwd);
                    self.buf.clear();
                    self.in_osc = false;
                } else if b == 0x1b {
                    // Start of ESC \ — next byte should be '\', handled on next iteration.
                    // We treat ESC itself as a terminator and check on the next byte.
                    self.dispatch(title, cwd);
                    self.buf.clear();
                    self.in_osc = false;
                } else if self.buf.len() < 8192 {
                    self.buf.push(b);
                }
            } else if b == 0x1b {
                // Could be ESC ] — we peek on next byte via a small state trick:
                // store ESC in buf and treat the next byte as the start.
                self.buf.push(b);
            } else if b == b']' && self.buf.last() == Some(&0x1b) {
                self.buf.clear();
                self.in_osc = true;
            } else {
                self.buf.clear();
            }
        }
    }

    fn dispatch(&mut self, title: &Arc<Mutex<Option<String>>>, cwd: &Arc<Mutex<Option<String>>>) {
        // buf contains everything after "ESC ]" and before the terminator.
        // Format: "<code>;<payload>"
        let Ok(s) = std::str::from_utf8(&self.buf) else {
            return;
        };
        let Some((code_str, payload)) = s.split_once(';') else {
            return;
        };
        let Ok(code) = code_str.parse::<u32>() else {
            return;
        };
        let changed = match code {
            0 | 2 if !payload.is_empty() => {
                *title.lock().unwrap() = Some(payload.to_string());
                true
            }
            7 => {
                // OSC 7 payload is normally a URI "scheme://hostname/path" —
                // extract the path. The scheme is usually `file://`, but some
                // shells emit other schemes with the same shape (e.g. zsh on
                // macOS emits `kitty-shell-cwd://host/path`), so match any
                // `scheme://` rather than `file://` specifically. Only `file`
                // URIs are percent-encoded (`kitty-shell-cwd` is raw). A bare
                // path (no scheme) is taken as-is.
                let path = if let Some(scheme_end) = payload.find("://") {
                    let rest = &payload[scheme_end + 3..];
                    // Strip optional hostname (everything up to next '/').
                    let path = rest.find('/').map_or(rest, |slash| &rest[slash..]);
                    if payload[..scheme_end].eq_ignore_ascii_case("file") {
                        percent_decode(path)
                    } else {
                        path.to_string()
                    }
                } else {
                    payload.to_string()
                };
                // `file:///C:/x` names `C:/x`, `file:////server/share` a UNC path.
                #[cfg(windows)]
                let path = match path.as_bytes() {
                    [b'/', drive, b':', ..] if drive.is_ascii_alphabetic() => path[1..].to_string(),
                    [b'/', b'/', b'/', ..] => path[1..].replace('/', "\\"),
                    _ => path,
                };
                if !path.is_empty() {
                    *cwd.lock().unwrap() = Some(path);
                    self.reported_cwd = true;
                    true
                } else {
                    false
                }
            }
            133 => {
                match payload.as_bytes().first() {
                    Some(b'A') => mark_prompt(&self.prompt, false),
                    Some(b'C') => mark_prompt(&self.prompt, true),
                    _ => {}
                }
                false
            }
            _ => false,
        };
        if changed {
            let _ = self.meta_tx.send(());
        }
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use std::os::fd::BorrowedFd;
    use std::time::Instant;
    fn pane(shell: &str) -> PtyHandle {
        let env = PtyEnv {
            exit_tx: mpsc::unbounded_channel().0,
            meta_tx: mpsc::unbounded_channel().0,
            port: 8044,
            palette: colors::SharedPalette::default(),
        };
        PtyHandle::new_with_cwd(shell, Uuid::new_v4(), &env, None, 100)
    }
    #[tokio::test]
    async fn spawn_failures_are_recoverable() {
        let mut pane = pane("/nonexistent/btmux-test-shell");
        assert!(pane.ensure_spawned(80, 24).is_err());
        assert!(!pane.is_spawned());
        assert!(pane.ensure_spawned(0, 24).is_err());
    }
    #[tokio::test]
    async fn input_is_bounded() {
        let (tx, _rx) = mpsc::channel(1);
        let input = InputSender(tx);
        assert!(input.send(vec![0; 65537]).is_err());
        assert!(input.send(vec![0; 65536]).is_ok());
        assert!(input.send(vec![0]).is_err());
    }
    #[tokio::test]
    async fn shell_commands_do_not_reach_foreground_programs() {
        let mut pane = pane("/bin/bash");
        pane.ensure_spawned(80, 24).unwrap();
        let shell_pid = pane.shell_pid.unwrap();
        let pane_ref = &pane;
        let wait_for_foreground = |shell_owns_terminal| async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let foreground = pane_ref.foreground_pgrp();
                    if (foreground == Some(shell_pid)) == shell_owns_terminal {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        };

        wait_for_foreground(true).await;
        pane.input_tx.send(b"cat\r".to_vec()).unwrap();
        wait_for_foreground(false).await;
        let result = pane
            .send_shell_command(b"printf 'SHOULD_NOT_RUN'\r".to_vec())
            .await;
        assert!(result.unwrap_err().contains("not at a shell prompt"));

        pane.input_tx.send(vec![3]).unwrap();
        wait_for_foreground(true).await;
        pane.send_shell_command(b"printf 'SHELL_READY'\r".to_vec())
            .await
            .unwrap();
    }
    async fn wait_until(pane: &PtyHandle, condition: impl Fn(&PtyHandle) -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !condition(pane) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    fn cwd(pane: &PtyHandle) -> Option<String> {
        pane.cwd.lock().unwrap().clone()
    }
    #[tokio::test]
    async fn cwd_follows_foreground_shells_without_osc7() {
        let mut pane = pane("/bin/sh");
        pane.ensure_spawned(80, 24).unwrap();
        pane.input_tx.send(b"cd /\n".to_vec()).unwrap();
        wait_until(&pane, |pane| cwd(pane).as_deref() == Some("/")).await;
        pane.input_tx.send(b"sh\ncd /usr\n".to_vec()).unwrap();
        wait_until(&pane, |pane| cwd(pane).as_deref() == Some("/usr")).await;
        let nested = pane.foreground_pgrp();

        // A shell that execs a program: the program's directory isn't the pane's.
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx
            .send(
                b"sh -c \"echo BTMUX_''READY; read x; exec perl -e 'chdir q(/bin); exec q(cat)'\"\n"
                    .to_vec(),
            )
            .unwrap();
        read_until(&mut rx, "BTMUX_READY").await;
        assert_ne!(pane.foreground_pgrp(), nested);
        pane.input_tx.send(b"\nx\n".to_vec()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(cwd(&pane).as_deref(), Some("/usr"));
    }
    #[tokio::test]
    async fn reply_bursts_keep_the_pane_alive() {
        let (exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        let env = PtyEnv {
            exit_tx,
            meta_tx: mpsc::unbounded_channel().0,
            port: 8044,
            palette: colors::SharedPalette::default(),
        };
        env.palette
            .set(colors::Palette::from_theme(&crate::config::default_theme()));
        let mut pane = PtyHandle::new_with_cwd("/bin/sh", Uuid::new_v4(), &env, None, 100);
        pane.ensure_spawned(80, 24).unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx
            .send(
                b"s=; i=0; while [ $i -lt 256 ]; do s=\"$s\\033]4;$i;?\\007\"; \
                  i=$((i+1)); done; printf \"$s\"; printf 'BTMUX_''ALIVE\\n'\r"
                    .to_vec(),
            )
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut text = String::new();
            while !text.contains("BTMUX_ALIVE") {
                if let Output::Data(bytes) = rx.recv().await.unwrap() {
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        })
        .await
        .unwrap();
        assert!(exit_rx.try_recv().is_err());
    }
    fn deadline() -> Instant {
        Instant::now() + std::time::Duration::from_secs(2)
    }
    async fn read_until(rx: &mut broadcast::Receiver<Output>, needle: &str) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut text = String::new();
            while !text.contains(needle) {
                match rx.recv().await {
                    Ok(Output::Data(bytes)) => text.push_str(&String::from_utf8_lossy(&bytes)),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(error) => panic!("{error}"),
                }
            }
            text
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn handoff_keeps_shell_replay_and_colors() {
        let mut old = pane("/bin/sh");
        old.ensure_spawned(80, 24).unwrap();
        let pid = old.shell_pid.unwrap();
        let (mut rx, _) = old.subscribe_replay();
        // A program-set color, then a sequence split across the handoff.
        old.input_tx
            .send(b"printf '\\033]10;#123456\\007BEFORE_''HANDOFF\\n\\033]2;ti'\r".to_vec())
            .unwrap();
        read_until(&mut rx, "BEFORE_HANDOFF").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        old.stop_io();
        let (fd, handoff) = old.export_handoff(deadline()).unwrap().unwrap();
        assert_eq!(handoff.pid, pid);
        // The prompt joins the unterminated title.
        assert!(handoff.pending.starts_with(b"\x1b]2;ti"));
        let master = unsafe { BorrowedFd::borrow_raw(fd) }
            .try_clone_to_owned()
            .unwrap();
        // The old process image is gone after exec; never drop it here.
        std::mem::forget(old);

        let mut new = pane("/bin/sh");
        new.adopt(master, handoff).unwrap();
        let (mut rx, replay) = new.subscribe_replay();
        let replay: Vec<u8> = replay
            .into_iter()
            .filter_map(|event| match event {
                Output::Data(bytes) => Some(bytes.to_vec()),
                _ => None,
            })
            .flatten()
            .collect();
        assert!(String::from_utf8_lossy(&replay).contains("BEFORE_HANDOFF"));
        new.input_tx
            .send(b"printf 'tle\\007AFTER_''HANDOFF:%s\\n' $$\r".to_vec())
            .unwrap();
        read_until(&mut rx, &format!("AFTER_HANDOFF:{pid}")).await;
        let title = new.title.lock().unwrap().clone().unwrap();
        assert!(
            title.starts_with("ti") && title.ends_with("tle"),
            "{title:?}"
        );
        new.stop_io();
        let (_, handoff) = new.export_handoff(deadline()).unwrap().unwrap();
        assert_eq!(handoff.colors[256], Some([0x12, 0x34, 0x56]));
    }
    #[tokio::test]
    async fn handoff_keeps_unwritten_input() {
        let mut old = pane("/bin/sh");
        old.ensure_spawned(80, 24).unwrap();
        let (mut rx, _) = old.subscribe_replay();
        old.input_tx
            .send(
                b"stty raw -echo; printf 'RAW_''READY'; sleep 2; head -c 262144 | wc -c\r".to_vec(),
            )
            .unwrap();
        read_until(&mut rx, "RAW_READY").await;
        for _ in 0..4 {
            old.input_tx.send(vec![b'x'; 64 * 1024]).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        old.stop_io();
        let (fd, handoff) = old.export_handoff(deadline()).unwrap().unwrap();
        assert!(!handoff.input.is_empty());
        let master = unsafe { BorrowedFd::borrow_raw(fd) }
            .try_clone_to_owned()
            .unwrap();
        std::mem::forget(old);

        let mut new = pane("/bin/sh");
        new.adopt(master, handoff).unwrap();
        let (mut rx, _) = new.subscribe_replay();
        read_until(&mut rx, "262144").await;
    }

    #[tokio::test]
    async fn replies_racing_a_handoff_keep_the_shell() {
        let palette = colors::SharedPalette::default();
        palette.set(colors::Palette::from_theme(&crate::config::default_theme()));
        let env = PtyEnv {
            exit_tx: mpsc::unbounded_channel().0,
            meta_tx: mpsc::unbounded_channel().0,
            port: 8044,
            palette: palette.clone(),
        };
        let mut pane = PtyHandle::new_with_cwd("/bin/sh", Uuid::new_v4(), &env, None, 100);
        pane.ensure_spawned(80, 24).unwrap();
        let pid = pane.shell_pid.unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx.send(b"printf 'READY'\r".to_vec()).unwrap();
        read_until(&mut rx, "READY").await;
        // The reader blocks answering the query while the writer stops.
        let lock = palette.lock();
        pane.input_tx
            .send(b"printf '\\033]11;?\\007'\r".to_vec())
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        pane.stop_io();
        std::thread::sleep(std::time::Duration::from_millis(100));
        drop(lock);
        let (_, handoff) = pane
            .export_handoff(deadline())
            .unwrap()
            .expect("the stopped shell is handed off");
        assert_eq!(handoff.pid, pid);
        // The next server writes the reply.
        assert!(
            handoff.input.starts_with(b"\x1b]11;"),
            "{:?}",
            handoff.input
        );
    }

    #[tokio::test]
    async fn failed_handoff_resumes_shell() {
        let mut pane = pane("/bin/sh");
        pane.ensure_spawned(80, 24).unwrap();
        let pid = pane.shell_pid.unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.stop_io();
        let (_, handoff) = pane.export_handoff(deadline()).unwrap().unwrap();
        pane.resume(handoff).unwrap();
        pane.input_tx
            .send(b"printf 'RESUMED_''%s\\n' $$\r".to_vec())
            .unwrap();
        read_until(&mut rx, &format!("RESUMED_{pid}")).await;
    }

    /// A pane whose reader is blocked answering a color query.
    async fn stuck_pane() -> (
        PtyHandle,
        colors::SharedPalette,
        broadcast::Receiver<Output>,
    ) {
        let palette = colors::SharedPalette::default();
        palette.set(colors::Palette::from_theme(&crate::config::default_theme()));
        let env = PtyEnv {
            exit_tx: mpsc::unbounded_channel().0,
            meta_tx: mpsc::unbounded_channel().0,
            port: 8044,
            palette: palette.clone(),
        };
        let mut pane = PtyHandle::new_with_cwd("/bin/sh", Uuid::new_v4(), &env, None, 100);
        pane.ensure_spawned(80, 24).unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx.send(b"printf 'READY'\r".to_vec()).unwrap();
        read_until(&mut rx, "READY").await;
        (pane, palette, rx)
    }

    #[tokio::test]
    async fn stuck_handoff_recovers_shell() {
        let (mut pane, palette, mut rx) = stuck_pane().await;
        let pid = pane.shell_pid.unwrap();
        let lock = palette.lock();
        // `ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL` is 24 bytes.
        pane.input_tx
            .send(
                b"stty -echo -icanon; printf '\\033]11;?\\007'; head -c 24 >/dev/null; \
                  stty sane; echo GOT_''REPLY\r"
                    .to_vec(),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        pane.stop_io();
        assert!(pane.export_handoff(Instant::now()).is_err());
        drop(lock);
        pane.recover(deadline()).unwrap();
        // The query's program gets the reply.
        read_until(&mut rx, "GOT_REPLY").await;
        pane.input_tx
            .send(b"printf 'RECOVERED_''%s\\n' $$\r".to_vec())
            .unwrap();
        read_until(&mut rx, &format!("RECOVERED_{pid}")).await;
    }

    #[tokio::test]
    async fn late_reader_is_restarted_without_its_state() {
        let (mut pane, palette, mut rx) = stuck_pane().await;
        let pid = pane.shell_pid.unwrap();
        let lock = palette.lock();
        pane.input_tx
            .send(b"printf '\\033]11;?\\007'\r".to_vec())
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        pane.stop_io();
        assert!(pane.export_handoff(Instant::now()).is_err());
        pane.recover(Instant::now()).unwrap();
        drop(lock);
        pane.input_tx
            .send(b"printf 'RESTARTED_''%s\\n' $$\r".to_vec())
            .unwrap();
        read_until(&mut rx, &format!("RESTARTED_{pid}")).await;
    }

    #[tokio::test]
    async fn recovering_a_running_pane_does_nothing() {
        let (mut pane, _palette, mut rx) = stuck_pane().await;
        pane.recover(Instant::now()).unwrap();
        pane.input_tx
            .send(b"printf 'STILL_''RUNNING'\r".to_vec())
            .unwrap();
        read_until(&mut rx, "STILL_RUNNING").await;
    }

    #[tokio::test]
    async fn adopted_shells_run_the_current_binary() {
        let mut pane = pane("/bin/sh");
        pane.bin = server_exe().map(Path::to_path_buf);
        assert_eq!(pane.shell_bin(), "\"$BTMUX_BIN\"");
        pane.bin = Some("/old/btmux".into());
        let exe = server_exe().unwrap();
        assert_eq!(
            pane.shell_bin(),
            crate::shell::Dialect::Posix.quote(&exe.to_string_lossy())
        );
    }
    #[tokio::test]
    async fn oldest_viewer_owns_size_until_disconnect() {
        let mut pane = pane("/bin/sh");
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        pane.attach_viewer(a, 100, 30);
        pane.attach_viewer(b, 80, 24);
        pane.resize_viewer(b, 90, 25);
        assert_eq!(*pane.size.lock().unwrap(), (100, 30));
        pane.detach_viewer(a);
        assert_eq!(*pane.size.lock().unwrap(), (90, 25));
    }
    #[tokio::test]
    async fn claiming_viewer_takes_size_ownership() {
        let mut pane = pane("/bin/sh");
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let owner = pane.subscribe_owner();
        pane.attach_viewer(a, 100, 30);
        pane.attach_viewer(b, 80, 24);
        assert_eq!(*owner.borrow(), Some(a));
        pane.resize_viewer(b, 90, 25);
        pane.claim_viewer(b);
        assert_eq!(*pane.size.lock().unwrap(), (90, 25));
        assert_eq!(*owner.borrow(), Some(b));
        pane.resize_viewer(a, 120, 40);
        assert_eq!(*pane.size.lock().unwrap(), (90, 25));
        pane.detach_viewer(b);
        assert_eq!(*pane.size.lock().unwrap(), (120, 40));
        assert_eq!(*owner.borrow(), Some(a));
    }
    #[tokio::test]
    async fn dropping_pane_terminates_and_reaps_shell() {
        let mut pane = pane("/bin/sh");
        pane.ensure_spawned(80, 24).unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx
            .send(b"printf '\\nBTMUX_PID:%s\\n' $$\r".to_vec())
            .unwrap();
        let pid: Pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut text = String::new();
            loop {
                if let Output::Data(bytes) = rx.recv().await.unwrap() {
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
                if let Some(pid) = text.lines().find_map(|line| {
                    line.trim()
                        .strip_prefix("BTMUX_PID:")
                        .and_then(|value| value.parse().ok())
                }) {
                    break pid;
                }
            }
        })
        .await
        .unwrap();
        drop(pane);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[cfg(test)]
mod osc_tests {
    use super::*;

    #[test]
    fn prompt_marks_number_commands() {
        let state = AtomicU32::new(0);
        let mut seen = Vec::new();
        for command in [true, false, false, true, true, false] {
            mark_prompt(&state, command);
            seen.push(state.load(Ordering::Relaxed));
        }
        assert_eq!(seen, [2, 3, 3, 4, 4, 5]);
    }

    fn cwd_of(seq: &[u8]) -> Option<String> {
        let mut parser = OscParser::new(mpsc::unbounded_channel().0, Arc::default());
        let (title, cwd) = Default::default();
        parser.feed(seq, &title, &cwd);
        let cwd = cwd.lock().unwrap().clone();
        cwd
    }

    #[test]
    fn decodes_file_uri_cwd() {
        assert_eq!(
            cwd_of(b"\x1b]7;file://host/a%20b/%C3%A9%2\x07").as_deref(),
            Some("/a b/\u{e9}%2")
        );
        assert_eq!(
            cwd_of(b"\x1b]7;file://host/x%+1\x07").as_deref(),
            Some("/x%+1")
        );
        assert_eq!(
            cwd_of(b"\x1b]7;kitty-shell-cwd://host/a%20b\x07").as_deref(),
            Some("/a%20b")
        );
        assert_eq!(cwd_of(b"\x1b]7;/a%20b\x07").as_deref(), Some("/a%20b"));
    }

    #[test]
    fn utf8_continuation_bytes_are_not_c1() {
        // U+0F4C ends in 0x9d (C1 OSC); "Ü" contains 0x9c (C1 ST).
        assert_eq!(cwd_of("\u{f4c}7;/x\x07".as_bytes()), None);
        assert_eq!(
            cwd_of("\x1b]7;/Übersicht\x07".as_bytes()).as_deref(),
            Some("/Übersicht")
        );
    }
}
