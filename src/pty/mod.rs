pub mod replay;
#[allow(dead_code)]
pub mod vt_query;
use axum::body::Bytes;
use replay::{Output, Replay};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::io::RawFd;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};
use uuid::Uuid;

#[derive(Clone)]
pub struct InputSender(mpsc::Sender<Vec<u8>>);
impl InputSender {
    pub async fn send_wait(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > 64 * 1024 {
            return Err("PTY input exceeds 64 KiB".into());
        }
        self.0
            .send(data)
            .await
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }
    pub fn send(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > 64 * 1024 {
            return Err("PTY input exceeds 64 KiB; split it into smaller requests".into());
        }
        self.0
            .try_send(data)
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }
}

pub struct PtyHandle {
    pub input_tx: InputSender,
    output_tx: broadcast::Sender<Output>,
    resize_tx: watch::Sender<(u16, u16)>,
    scrollback: Arc<Mutex<Replay>>,
    killer: Arc<Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>>,
    viewers: Vec<(Uuid, u16, u16)>,
    size: Arc<Mutex<(u16, u16)>>,
    spawned: Arc<Mutex<bool>>,
    shell: String,
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
    pending_cpr_pgrps: Arc<Mutex<VecDeque<libc::pid_t>>>,
    /// Borrowed master fd for tcgetpgrp; invalidated under this mutex on drop.
    master_fd: Arc<Mutex<Option<RawFd>>>,
    /// Last OSC 0/2 title emitted by the shell.
    pub title: Arc<Mutex<Option<String>>>,
    /// Last OSC 7 cwd URI emitted by the shell.
    pub cwd: Arc<Mutex<Option<String>>>,
    /// Server port, injected as BTMUX_API_URL into the shell environment.
    port: u16,
    /// Maximum backend replay buffer size in bytes, derived from the config's
    /// scrollback line count. Controls how much PTY output is kept for replay
    /// on reconnect; ghostty-web's in-memory scrollback uses the line count directly.
    scrollback_bytes: usize,
}

impl PtyHandle {
    pub fn new_with_cwd(
        shell: &str,
        pane_id: Uuid,
        exit_tx: mpsc::UnboundedSender<Uuid>,
        meta_tx: mpsc::UnboundedSender<()>,
        spawn_cwd: Option<std::path::PathBuf>,
        port: u16,
        scrollback_lines: u32,
    ) -> Self {
        let (input_tx, _) = mpsc::channel::<Vec<u8>>(32);
        let (output_tx, _) = broadcast::channel::<Output>(256);
        let (resize_tx, _) = watch::channel((80, 24));

        Self {
            input_tx: InputSender(input_tx),
            output_tx,
            resize_tx,
            scrollback: Arc::new(Mutex::new(Replay::new(
                80,
                24,
                scrollback_lines as usize * 1000,
            ))),
            killer: Arc::new(Mutex::new(None)),
            viewers: Vec::new(),
            size: Arc::new(Mutex::new((0, 0))),
            spawned: Arc::new(Mutex::new(false)),
            shell: shell.to_string(),
            spawn_cwd,
            pane_id,
            exit_tx,
            meta_tx,
            pending_cpr_pgrps: Arc::new(Mutex::new(VecDeque::new())),
            master_fd: Arc::new(Mutex::new(None)),
            title: Arc::new(Mutex::new(None)),
            cwd: Arc::new(Mutex::new(None)),
            port,
            scrollback_bytes: scrollback_lines as usize * 1000,
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

    pub fn ensure_spawned(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        {
            let spawned = self.spawned.lock().unwrap();
            if *spawned {
                return Ok(());
            }
        }

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open PTY: {e}"))?;

        // Set proper termios attributes on the PTY master.
        // portable-pty passes NULL termios to openpty(), resulting in minimal
        // defaults that lack IUTF8 and other flags that shells like fish expect.
        // node-pty sets these, which is why it works without the DA warning.
        if let Some(master_fd) = pair.master.as_raw_fd() {
            Self::configure_termios(master_fd);
        }

        // Get reader and writer BEFORE spawning the shell so we never miss output
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        // Prepare all fallible resources before starting worker threads. The PTY
        // kernel buffer retains initial shell output until the reader starts.
        let mut cmd = CommandBuilder::new(&self.shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("BTMUX_PANE_ID", self.pane_id.to_string());
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

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;
        drop(pair.slave);

        *self.killer.lock().unwrap() = Some(child.clone_killer());
        let child_killer = self.killer.clone();
        *self.scrollback.lock().unwrap() = Replay::new(cols, rows, self.scrollback_bytes);
        let child_exit_tx = self.exit_tx.clone();
        let child_pane_id = self.pane_id;
        std::thread::spawn(move || {
            let _ = child.wait();
            child_killer.lock().unwrap().take();
            let _ = child_exit_tx.send(child_pane_id);
        });

        // Store the master fd for foreground-process-group checks.
        let master_raw_fd = pair.master.as_raw_fd();
        if let Some(fd) = master_raw_fd {
            *self.master_fd.lock().unwrap() = Some(fd);
        }

        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(32);
        let (resize_tx, mut resize_rx) = watch::channel((cols, rows));
        let response_tx = InputSender(input_tx.clone());

        // Start the reader after successful spawn; no fallible setup remains.
        let output_tx_clone = self.output_tx.clone();
        let scrollback_clone = self.scrollback.clone();
        let exit_tx = self.exit_tx.clone();
        let pane_id = self.pane_id;
        let title_arc = self.title.clone();
        let cwd_arc = self.cwd.clone();
        let meta_tx = self.meta_tx.clone();
        let pending_cpr_pgrps_reader = self.pending_cpr_pgrps.clone();
        let master_fd_reader = self.master_fd.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut osc_parser = OscParser::new(meta_tx);
            let mut interceptor = vt_query::VtQueryInterceptor::new();
            'read: loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let result = interceptor.feed(&buf[..n]);

                        for response in &result.responses {
                            if let Err(error) = response_tx.send(response.to_vec()) {
                                tracing::warn!(%pane_id, %error, "PTY response queue exhausted");
                                break 'read;
                            }
                        }
                        for _ in 0..result.forwarded_cpr_queries {
                            Self::record_cpr_pgrp(&master_fd_reader, &pending_cpr_pgrps_reader);
                        }

                        osc_parser.feed(&result.scrollback, &title_arc, &cwd_arc);
                        {
                            let mut sb = scrollback_clone.lock().unwrap();
                            sb.push(Output::Data(Bytes::from(result.scrollback)));
                            let _ =
                                output_tx_clone.send(Output::Data(Bytes::from(result.broadcast)));
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = exit_tx.send(pane_id);
        });

        // Dedicated blocking writer — serializes input and backend DA replies,
        // filtering stale CPR responses from emulator input.
        let pending_cpr_pgrps_writer = self.pending_cpr_pgrps.clone();
        let master_fd_writer = self.master_fd.clone();
        std::thread::spawn(move || {
            while let Some(data) = input_rx.blocking_recv() {
                let filtered =
                    Self::filter_stale_cpr(&data, &pending_cpr_pgrps_writer, &master_fd_writer);
                if filtered.is_empty() {
                    continue;
                }
                if writer.write_all(&filtered).is_err() {
                    break;
                }
            }
        });

        // Resize thread owns the master handle
        let master = pair.master;
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            while runtime.block_on(resize_rx.changed()).is_ok() {
                let (cols, rows) = *resize_rx.borrow_and_update();
                let _ = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        });

        self.input_tx = InputSender(input_tx);
        self.resize_tx = resize_tx;
        *self.size.lock().unwrap() = (cols, rows);
        *self.spawned.lock().unwrap() = true;
        Ok(())
    }

    /// Record the current foreground process group for a forwarded DSR 6 query.
    fn record_cpr_pgrp(
        master_fd: &Mutex<Option<RawFd>>,
        pending_cpr_pgrps: &Mutex<VecDeque<libc::pid_t>>,
    ) {
        let pgrp = master_fd
            .lock()
            .unwrap()
            .map(|fd| unsafe { libc::tcgetpgrp(fd) })
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
        pending_cpr_pgrps: &Mutex<VecDeque<libc::pid_t>>,
        master_fd: &Mutex<Option<RawFd>>,
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
                            let current_pgrp = master_fd
                                .lock()
                                .unwrap()
                                .map(|fd| unsafe { libc::tcgetpgrp(fd) })
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

    fn configure_termios(fd: RawFd) {
        use nix::sys::termios::{self, SetArg};

        let fd_borrowed = unsafe { std::os::unix::io::BorrowedFd::borrow_raw(fd) };
        if let Ok(mut attrs) = termios::tcgetattr(fd_borrowed) {
            // Set IUTF8 - tells the kernel the terminal uses UTF-8.
            // Without this, fish detects the PTY as non-UTF-8 capable and
            // the DA query response handling breaks.
            attrs.input_flags.insert(termios::InputFlags::IUTF8);
            // ECHOK: echo newline after kill character - standard terminal behavior
            attrs.local_flags.insert(termios::LocalFlags::ECHOK);
            // IMAXBEL: ring bell on input queue full
            attrs.input_flags.insert(termios::InputFlags::IMAXBEL);

            let _ = termios::tcsetattr(fd_borrowed, SetArg::TCSANOW, &attrs);
        }
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
            let _ = self.resize_tx.send((cols, rows));
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

    pub fn subscribe_replay(&self) -> (broadcast::Receiver<Output>, Vec<Output>) {
        let replay = self.scrollback.lock().unwrap();
        (self.output_tx.subscribe(), replay.snapshot())
    }

    // The first attached interactive viewer owns the shared PTY dimensions.
    // Followers receive ordered size events; mirrors never acquire ownership.
    pub fn attach_viewer(&mut self, id: Uuid, cols: u16, rows: u16) {
        self.viewers.push((id, cols, rows));
        if self.viewers.len() == 1 {
            self.resize(cols, rows);
        }
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
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
        return Err("PTY size must be 1..500 columns and 1..200 rows".into());
    }
    Ok(())
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // Invalidate the borrowed descriptor before its owning resize thread
        // can close it and the OS can reuse its number.
        if let Some(fd) = self.master_fd.lock().unwrap().take() {
            let pgrp = unsafe { libc::tcgetpgrp(fd) };
            if pgrp > 0 {
                unsafe {
                    libc::kill(-pgrp, libc::SIGHUP);
                }
            }
        }
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }
}

/// Incremental OSC sequence parser. Handles sequences split across read() chunks.
/// Parses OSC 0/2 (window title) and OSC 7 (working directory URI).
struct OscParser {
    buf: Vec<u8>,
    in_osc: bool,
    meta_tx: mpsc::UnboundedSender<()>,
}

impl OscParser {
    fn new(meta_tx: mpsc::UnboundedSender<()>) -> Self {
        Self {
            buf: Vec::new(),
            in_osc: false,
            meta_tx,
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
                // BEL (0x07) or ST (0x9c / ESC \) terminates the sequence.
                if b == 0x07 || b == 0x9c {
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
            } else if b == 0x9d {
                // C1 OSC
                self.in_osc = true;
                self.buf.clear();
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

    fn dispatch(&self, title: &Arc<Mutex<Option<String>>>, cwd: &Arc<Mutex<Option<String>>>) {
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
                // `scheme://` rather than `file://` specifically. A bare path
                // (no scheme) is taken as-is.
                let path = if let Some(scheme_end) = payload.find("://") {
                    let rest = &payload[scheme_end + 3..];
                    // Strip optional hostname (everything up to next '/').
                    if let Some(slash) = rest.find('/') {
                        &rest[slash..]
                    } else {
                        rest
                    }
                } else {
                    payload
                };
                if !path.is_empty() {
                    *cwd.lock().unwrap() = Some(path.to_string());
                    true
                } else {
                    false
                }
            }
            _ => false,
        };
        if changed {
            let _ = self.meta_tx.send(());
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn pane(shell: &str) -> PtyHandle {
        let (exit_tx, _) = mpsc::unbounded_channel();
        let (meta_tx, _) = mpsc::unbounded_channel();
        PtyHandle::new_with_cwd(shell, Uuid::new_v4(), exit_tx, meta_tx, None, 8044, 100)
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
    async fn dropping_pane_terminates_and_reaps_shell() {
        let mut pane = pane("/bin/sh");
        pane.ensure_spawned(80, 24).unwrap();
        let (mut rx, _) = pane.subscribe_replay();
        pane.input_tx
            .send(b"printf '\\nBTMUX_PID:%s\\n' $$\r".to_vec())
            .unwrap();
        let pid: libc::pid_t = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
