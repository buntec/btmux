use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::os::unix::io::RawFd;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

pub struct PtyHandle {
    pub input_tx: mpsc::UnboundedSender<Vec<u8>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    /// Broadcasts the new (cols, rows) whenever the PTY is resized, so read-only
    /// mirror sockets (the window-grid thumbnails) can re-fit to a pane that a
    /// real viewer resized in the background. The real `/ws/pane` viewer drives
    /// the size; mirrors only observe it.
    size_change_tx: broadcast::Sender<(u16, u16)>,
    scrollback: Arc<Mutex<Vec<u8>>>,
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
    /// Count of DSR 6 queries forwarded to the emulator that haven't been
    /// answered yet. The writer task checks this before passing a CPR response
    /// (`ESC[row;colR`) through to the PTY — if zero, the response is stale
    /// (the requesting app already exited) and is dropped silently.
    pending_cpr: Arc<AtomicU32>,
    /// Last OSC 0/2 title emitted by the shell.
    pub title: Arc<Mutex<Option<String>>>,
    /// Last OSC 7 cwd URI emitted by the shell.
    pub cwd: Arc<Mutex<Option<String>>>,
    /// Server port, injected as BTMUX_API_URL into the shell environment.
    port: u16,
}

impl PtyHandle {
    pub fn new(
        shell: &str,
        pane_id: Uuid,
        exit_tx: mpsc::UnboundedSender<Uuid>,
        meta_tx: mpsc::UnboundedSender<()>,
        port: u16,
    ) -> Self {
        Self::new_with_cwd(shell, pane_id, exit_tx, meta_tx, None, port)
    }

    pub fn new_with_cwd(
        shell: &str,
        pane_id: Uuid,
        exit_tx: mpsc::UnboundedSender<Uuid>,
        meta_tx: mpsc::UnboundedSender<()>,
        spawn_cwd: Option<std::path::PathBuf>,
        port: u16,
    ) -> Self {
        let (input_tx, _) = mpsc::unbounded_channel::<Vec<u8>>();
        let (output_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (resize_tx, _) = mpsc::unbounded_channel::<(u16, u16)>();
        let (size_change_tx, _) = broadcast::channel::<(u16, u16)>(16);

        Self {
            input_tx,
            output_tx,
            resize_tx,
            size_change_tx,
            scrollback: Arc::new(Mutex::new(Vec::new())),
            size: Arc::new(Mutex::new((0, 0))),
            spawned: Arc::new(Mutex::new(false)),
            shell: shell.to_string(),
            spawn_cwd,
            pane_id,
            exit_tx,
            meta_tx,
            pending_cpr: Arc::new(AtomicU32::new(0)),
            title: Arc::new(Mutex::new(None)),
            cwd: Arc::new(Mutex::new(None)),
            port,
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

    pub fn ensure_spawned(&mut self, cols: u16, rows: u16) {
        {
            let spawned = self.spawned.lock().unwrap();
            if *spawned {
                return;
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
            .expect("failed to open pty");

        // Set proper termios attributes on the PTY master.
        // portable-pty passes NULL termios to openpty(), resulting in minimal
        // defaults that lack IUTF8 and other flags that shells like fish expect.
        // node-pty sets these, which is why it works without the DA warning.
        if let Some(master_fd) = pair.master.as_raw_fd() {
            Self::configure_termios(master_fd);
        }

        // Get reader and writer BEFORE spawning the shell so we never miss output
        let mut writer = pair.master.take_writer().expect("failed to get pty writer");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("failed to get pty reader");

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();

        // Start reader thread BEFORE spawning shell
        let output_tx_clone = self.output_tx.clone();
        let scrollback_clone = self.scrollback.clone();
        let da_response_tx = input_tx.clone();
        let exit_tx = self.exit_tx.clone();
        let pane_id = self.pane_id;
        let title_arc = self.title.clone();
        let cwd_arc = self.cwd.clone();
        let meta_tx = self.meta_tx.clone();
        let pending_cpr_reader = self.pending_cpr.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut osc_parser = OscParser::new(meta_tx);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let (scrollback_chunk, broadcast_chunk) =
                            Self::strip_and_answer_da_queries(
                                &buf[..n],
                                &da_response_tx,
                                &pending_cpr_reader,
                            );
                        osc_parser.feed(&scrollback_chunk, &title_arc, &cwd_arc);
                        // Hold the scrollback lock across both the append AND the
                        // broadcast. subscribe_and_get_scrollback also holds this lock
                        // while subscribing — this ensures a new subscriber cannot
                        // snapshot a chunk AND then receive it again from the live
                        // stream (which would double-write and garble output).
                        // broadcast::send is non-blocking so holding the Mutex is safe.
                        {
                            let mut sb = scrollback_clone.lock().unwrap();
                            sb.extend_from_slice(&scrollback_chunk);
                            if sb.len() > 65536 {
                                let drain_to = sb.len() - 65536;
                                sb.drain(..drain_to);
                            }
                            let _ = output_tx_clone.send(broadcast_chunk);
                        }
                    }
                    Err(_) => break,
                }
            }
            // EOF or read error: the shell has exited. Tell the session manager so
            // it can remove this pane (and cascade up to window/session as needed).
            let _ = exit_tx.send(pane_id);
        });

        // Start writer task — filters stale CPR responses from emulator input
        let pending_cpr_writer = self.pending_cpr.clone();
        tokio::spawn(async move {
            while let Some(data) = input_rx.recv().await {
                let filtered = Self::filter_stale_cpr(&data, &pending_cpr_writer);
                if filtered.is_empty() {
                    continue;
                }
                if writer.write_all(&filtered).is_err() {
                    break;
                }
            }
        });

        // NOW spawn the shell — reader is already active
        let mut cmd = CommandBuilder::new(&self.shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("BTMUX_PANE_ID", self.pane_id.to_string());
        cmd.env("BTMUX_API_URL", format!("http://127.0.0.1:{}", self.port));
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if let Some(ref dir) = self.spawn_cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .expect("failed to spawn shell");
        drop(pair.slave);

        // Resize thread owns the master handle
        let master = pair.master;
        std::thread::spawn(move || {
            let _child = child;
            while let Some((cols, rows)) = resize_rx.blocking_recv() {
                let _ = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        });

        self.input_tx = input_tx;
        self.resize_tx = resize_tx;
        *self.size.lock().unwrap() = (cols, rows);
        *self.spawned.lock().unwrap() = true;
    }

    /// Intercept terminal query sequences from the shell's output. Returns two
    /// byte vectors: `(scrollback, broadcast)`.
    ///
    /// - `scrollback`: all queries stripped — safe for the replay buffer.
    /// - `broadcast`: DA1/DA2/DSR5 stripped (backend answers these), DSR 6 and
    ///   DECXCPR left **in place** so ghostty-web can answer with the real
    ///   cursor position. A `pending_cpr` counter is incremented for each
    ///   forwarded DSR 6/DECXCPR; `filter_stale_cpr` on the input path uses
    ///   this to drop CPR responses that arrive after the requesting app exits.
    ///
    /// DA responses are **ghostty-web's exact bytes** (pinned build). If
    /// ghostty-web is bumped and its DA replies change, re-probe and update.
    fn strip_and_answer_da_queries(
        data: &[u8],
        tx: &mpsc::UnboundedSender<Vec<u8>>,
        pending_cpr: &AtomicU32,
    ) -> (Vec<u8>, Vec<u8>) {
        let mut scrollback_out = Vec::with_capacity(data.len());
        let mut broadcast_out = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0x1b && i + 2 < data.len() && data[i + 1] == b'[' {
                let start = i + 2;
                let mut end = start;
                while end < data.len() && (data[end].is_ascii_digit() || data[end] == b';') {
                    end += 1;
                }
                // DA1: ESC[c or ESC[0c
                if end < data.len() && data[end] == b'c' {
                    let params = &data[start..end];
                    if params.is_empty() || params == b"0" {
                        let _ = tx.send(b"\x1b[?62;22c".to_vec());
                    }
                    i = end + 1;
                    continue;
                }
                // DSR queries: final byte 'n'
                if end < data.len() && data[end] == b'n' {
                    let params = &data[start..end];
                    match params {
                        // DSR 5 (device status) → answered by backend
                        b"5" => {
                            let _ = tx.send(b"\x1b[0n".to_vec());
                            i = end + 1;
                            continue;
                        }
                        // DSR 6 (cursor position) → forward to emulator
                        b"6" => {
                            pending_cpr.fetch_add(1, Ordering::Relaxed);
                            broadcast_out.extend_from_slice(&data[i..end + 1]);
                            i = end + 1;
                            continue;
                        }
                        _ => {}
                    }
                    i = end + 1;
                    continue;
                }
                // '?' prefix: DECXCPR (ESC[?6n)
                if start < data.len() && data[start] == b'?' {
                    let p_start = start + 1;
                    let mut p_end = p_start;
                    while p_end < data.len()
                        && (data[p_end].is_ascii_digit() || data[p_end] == b';')
                    {
                        p_end += 1;
                    }
                    if p_end < data.len() && data[p_end] == b'n' {
                        let params = &data[p_start..p_end];
                        if params == b"6" {
                            // DECXCPR → forward to emulator
                            pending_cpr.fetch_add(1, Ordering::Relaxed);
                            broadcast_out.extend_from_slice(&data[i..p_end + 1]);
                            i = p_end + 1;
                            continue;
                        }
                        i = p_end + 1;
                        continue;
                    }
                }
                // '>' prefix: DA2 (ESC[>c or ESC[>0c)
                if start < data.len() && data[start] == b'>' {
                    let p_start = start + 1;
                    let mut p_end = p_start;
                    while p_end < data.len()
                        && (data[p_end].is_ascii_digit() || data[p_end] == b';')
                    {
                        p_end += 1;
                    }
                    if p_end < data.len() && data[p_end] == b'c' {
                        let params = &data[p_start..p_end];
                        if params.is_empty() || params == b"0" {
                            let _ = tx.send(b"\x1b[>1;0;0c".to_vec());
                        }
                        i = p_end + 1;
                        continue;
                    }
                }
            }
            scrollback_out.push(data[i]);
            broadcast_out.push(data[i]);
            i += 1;
        }
        (scrollback_out, broadcast_out)
    }

    /// Filter CPR responses (`ESC[row;colR`) from emulator input. If a pending
    /// DSR 6 request exists, the response is passed through and the counter
    /// decremented. Otherwise it's a stale response (app exited before the
    /// browser round-trip completed) and is dropped to prevent shell echo.
    fn filter_stale_cpr(data: &[u8], pending_cpr: &AtomicU32) -> Vec<u8> {
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
                        // This looks like a CPR response
                        if pending_cpr.load(Ordering::Relaxed) > 0 {
                            pending_cpr.fetch_sub(1, Ordering::Relaxed);
                            out.extend_from_slice(&data[i..end + 1]);
                        }
                        // else: stale — drop silently
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
        let mut size = self.size.lock().unwrap();
        if *size != (cols, rows) {
            *size = (cols, rows);
            drop(size);
            self.scrollback.lock().unwrap().clear();
            let _ = self.resize_tx.send((cols, rows));
            // Notify mirror sockets so thumbnails re-fit to the new grid.
            let _ = self.size_change_tx.send((cols, rows));
        }
    }

    /// The PTY's current (cols, rows). `(0, 0)` until first spawned/resized.
    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap()
    }

    /// Subscribe to size changes. Read-only mirror sockets use this to re-fit a
    /// thumbnail when a real viewer resizes the pane in the background.
    pub fn subscribe_size(&self) -> broadcast::Receiver<(u16, u16)> {
        self.size_change_tx.subscribe()
    }

    pub fn is_spawned(&self) -> bool {
        *self.spawned.lock().unwrap()
    }

    /// Send SIGWINCH to the PTY at its current size without clearing the scrollback.
    /// Used on reconnect so TUI apps (e.g. Claude Code) redraw and restore their
    /// cursor state: the scrollback captures a snapshot that may include a
    /// mid-draw cursor-hide (`\x1b[?25l`) and the app never gets told a new
    /// client attached.
    pub fn force_sigwinch(&self) {
        if !*self.spawned.lock().unwrap() {
            return;
        }
        let (cols, rows) = *self.size.lock().unwrap();
        let _ = self.resize_tx.send((cols, rows));
    }

    /// Subscribe to live output and snapshot the scrollback buffer atomically.
    /// Holding the scrollback lock while subscribing ensures the reader thread
    /// cannot append-then-broadcast a chunk between the two operations, which
    /// would cause that chunk to appear in both the replay and the live stream.
    pub fn subscribe_and_get_scrollback(&self) -> (broadcast::Receiver<Vec<u8>>, Vec<u8>) {
        let sb = self.scrollback.lock().unwrap();
        let snapshot = sb.clone();
        let rx = self.output_tx.subscribe();
        (rx, snapshot)
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
                } else {
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
