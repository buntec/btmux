pub mod colors;
pub mod replay;
pub mod screen;
#[allow(dead_code)]
pub mod vt_query;
use axum::body::Bytes;
use replay::{Output, Replay};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::io::RawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use uuid::Uuid;

/// PTY state carried across an in-place upgrade; the master fd travels separately.
pub struct Handoff {
    pub pid: libc::pid_t,
    pub cols: u16,
    pub rows: u16,
    pub journal: Vec<Output>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub spawn_cwd: Option<std::path::PathBuf>,
    pub color_reports: bool,
    pub colors: Vec<Option<colors::Rgb>>,
    /// An escape sequence the reader had only partly seen.
    pub pending: Vec<u8>,
    /// Accepted input not yet written to the PTY.
    pub input: Vec<u8>,
    /// The `BTMUX_BIN` the shell was started with.
    pub bin: Option<std::path::PathBuf>,
}

/// What a reader stopped for a handoff leaves behind.
struct ReaderState {
    colors: Vec<Option<colors::Rgb>>,
    pending: Vec<u8>,
    /// Replies that reached the input queue after the writer stopped.
    unsent: Vec<u8>,
}

/// A report from a reader or writer stopped for a handoff.
enum Stopped {
    Reader(ReaderState),
    /// Input not yet written.
    Writer(Vec<u8>),
}

/// Collects the reports of a running reader and writer once told to stop.
struct Stopping {
    rx: std::sync::mpsc::Receiver<Stopped>,
    /// Whether `stop_io` ran.
    requested: bool,
    reader: Option<ReaderState>,
    input: Option<Vec<u8>>,
}

impl Stopping {
    /// Wait until both reported, or the reader ended without a report (the
    /// shell exited). `false` at `deadline`.
    fn wait(&mut self, deadline: Instant) -> bool {
        use std::sync::mpsc::RecvTimeoutError;
        while self.reader.is_none() || self.input.is_none() {
            let timeout = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(timeout) {
                Ok(Stopped::Reader(state)) => self.reader = Some(state),
                Ok(Stopped::Writer(input)) => self.input = Some(input),
                Err(RecvTimeoutError::Timeout) => return false,
                // A writer that failed sends nothing.
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        true
    }

    /// Unwritten input, including replies the stopped reader couldn't queue.
    fn input(&mut self) -> Vec<u8> {
        let mut input = self.input.take().unwrap_or_default();
        if let Some(reader) = &mut self.reader {
            input.append(&mut reader.unsent);
        }
        input
    }
}

/// Descriptors for a PTY's reader and writer threads.
struct PtyIo {
    reader: File,
    writer: File,
    stop_rx: OwnedFd,
    stop_tx: OwnedFd,
    writer_stop: OwnedFd,
}

impl PtyIo {
    fn new(master: &OwnedFd) -> Result<Self, String> {
        let io_error = |e: std::io::Error| format!("failed to start PTY: {e}");
        let (stop_rx, stop_tx) = pipe().map_err(io_error)?;
        Ok(Self {
            reader: File::from(master.try_clone().map_err(io_error)?),
            writer: File::from(master.try_clone().map_err(io_error)?),
            writer_stop: stop_rx.try_clone().map_err(io_error)?,
            stop_rx,
            stop_tx,
        })
    }
}

/// This server's binary, read at startup: once it is replaced on disk, Linux
/// reports `<path> (deleted)`.
pub fn server_exe() -> Option<&'static Path> {
    static EXE: LazyLock<Option<PathBuf>> = LazyLock::new(|| std::env::current_exe().ok());
    EXE.as_deref()
}

/// Hang up a shell no waiter thread watches, and reap it.
pub fn hang_up(pid: libc::pid_t) {
    unsafe { libc::kill(pid, libc::SIGHUP) };
    std::thread::spawn(move || {
        let mut status = 0;
        while unsafe { libc::waitpid(pid, &mut status, 0) } == -1
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
        {}
    });
}

/// A close-on-exec pipe: (read, write).
fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let pipe = unsafe {
        use std::os::fd::FromRawFd;
        (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1]))
    };
    set_cloexec(fds[0], true)?;
    set_cloexec(fds[1], true)?;
    Ok(pipe)
}

pub fn set_cloexec(fd: RawFd, enabled: bool) -> std::io::Result<()> {
    let flags = if enabled { libc::FD_CLOEXEC } else { 0 };
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Wait until `fd` is readable. `Ok(false)` means `stop` is readable or closed.
fn wait_readable(fd: RawFd, stop: RawFd) -> std::io::Result<bool> {
    wait_ready(fd, libc::POLLIN, stop)
}

/// Wait until `fd` is writable. `Ok(false)` means `stop` is readable or closed.
fn wait_writable(fd: RawFd, stop: RawFd) -> std::io::Result<bool> {
    wait_ready(fd, libc::POLLOUT, stop)
}

/// Whether `fd` is readable or closed, without waiting.
fn is_readable(fd: RawFd) -> bool {
    let mut pollfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut pollfd, 1, 0) > 0 }
}

fn wait_ready(fd: RawFd, events: libc::c_short, stop: RawFd) -> std::io::Result<bool> {
    let mut fds = [
        libc::pollfd {
            fd,
            events,
            revents: 0,
        },
        libc::pollfd {
            fd: stop,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    while unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(fds[1].revents == 0)
}

/// Write `data` unless `stop` fires first. `Ok(false)` leaves the rest in `data`.
fn write_until_stopped(file: &File, stop: RawFd, data: &mut Vec<u8>) -> std::io::Result<bool> {
    let mut written = 0;
    let result = loop {
        if written == data.len() {
            break Ok(true);
        }
        match wait_writable(file.as_raw_fd(), stop) {
            Ok(true) => {}
            other => break other,
        }
        match (&mut &*file).write(&data[written..]) {
            Ok(0) => break Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(e) => break Err(e),
        }
    };
    data.drain(..written);
    result
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
        shell_pid: libc::pid_t,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Wakes an idle writer for a handoff.
    Stop,
}

impl InputSender {
    pub async fn send_wait(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > 64 * 1024 {
            return Err("PTY input exceeds 64 KiB".into());
        }
        self.0
            .send(PtyInput::Raw(data))
            .await
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }
    pub fn send(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > 64 * 1024 {
            return Err("PTY input exceeds 64 KiB; split it into smaller requests".into());
        }
        self.0
            .try_send(PtyInput::Raw(data))
            .map_err(|e| format!("PTY input unavailable: {e}"))
    }

    async fn send_shell_command(
        &self,
        data: Vec<u8>,
        shell_pid: libc::pid_t,
    ) -> Result<(), String> {
        if data.len() > 64 * 1024 {
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
    child: Arc<Mutex<Option<libc::pid_t>>>,
    master: Option<OwnedFd>,
    /// Write end of the pipe that stops the reader.
    stop_reader: Option<OwnedFd>,
    stopping: Mutex<Option<Stopping>>,
    /// The `BTMUX_BIN` the shell was started with.
    bin: Option<std::path::PathBuf>,
    viewers: Vec<(Uuid, u16, u16)>,
    /// The interactive viewer whose size the PTY follows.
    owner_tx: watch::Sender<Option<Uuid>>,
    size: Arc<Mutex<(u16, u16)>>,
    spawned: Arc<Mutex<bool>>,
    shell_pid: Option<libc::pid_t>,
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
            stop_reader: None,
            stopping: Mutex::new(None),
            bin: None,
            viewers: Vec::new(),
            owner_tx: watch::channel(None).0,
            size: Arc::new(Mutex::new((0, 0))),
            spawned: Arc::new(Mutex::new(false)),
            shell_pid: None,
            shell: shell.to_string(),
            spawn_cwd,
            pane_id,
            exit_tx: env.exit_tx.clone(),
            meta_tx: env.meta_tx.clone(),
            pending_cpr_pgrps: Arc::new(Mutex::new(VecDeque::new())),
            master_fd: Arc::new(Mutex::new(None)),
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

    pub fn track_screen(&self, enabled: bool) {
        self.scrollback.lock().unwrap().track_screen(enabled);
    }

    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid.and_then(|pid| pid.try_into().ok())
    }

    pub fn foreground_pgrp(&self) -> Option<libc::pid_t> {
        self.master_fd
            .lock()
            .unwrap()
            .and_then(|fd| match unsafe { libc::tcgetpgrp(fd) } {
                pgrp if pgrp > 0 => Some(pgrp),
                _ => None,
            })
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
        let master_fd = pair
            .master
            .as_raw_fd()
            .ok_or("PTY master has no descriptor")?;

        // Set proper termios attributes on the PTY master.
        // portable-pty passes NULL termios to openpty(), resulting in minimal
        // defaults that lack IUTF8 and other flags that shells like fish expect.
        // node-pty sets these, which is why it works without the DA warning.
        Self::configure_termios(master_fd);

        // Our own close-on-exec copy, which outlives portable-pty's handles
        // and can be passed to an upgraded server.
        let master = unsafe { BorrowedFd::borrow_raw(master_fd) }
            .try_clone_to_owned()
            .map_err(|e| format!("failed to open PTY: {e}"))?;

        // Prepare all fallible resources before starting worker threads. The PTY
        // kernel buffer retains initial shell output until the reader starts.
        let mut cmd = CommandBuilder::new(&self.shell);
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

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;
        // `start` reaps the shell with waitpid; dropping `child` doesn't wait.
        let pid = child.process_id().and_then(|pid| pid.try_into().ok());
        drop(child);
        drop(pair);
        let pid = pid.ok_or("spawned shell has no pid")?;

        let interceptor = vt_query::VtQueryInterceptor::with_colors(
            self.palette.clone(),
            self.color_reports.clone(),
        );
        let replay = Replay::new(cols, rows, self.scrollback_bytes);
        self.start(
            master,
            pid,
            cols,
            rows,
            replay,
            interceptor,
            Vec::new(),
            Vec::new(),
        )
        .inspect_err(|_| hang_up(pid))
    }

    /// Take over a shell from the server that re-executed into this one.
    pub fn adopt(&mut self, master: OwnedFd, handoff: Handoff) -> Result<(), String> {
        set_cloexec(master.as_raw_fd(), true).map_err(|e| e.to_string())?;
        *self.title.lock().unwrap() = handoff.title;
        *self.cwd.lock().unwrap() = handoff.cwd;
        self.spawn_cwd = handoff.spawn_cwd;
        self.bin = handoff.bin;
        self.color_reports
            .store(handoff.color_reports, Ordering::Relaxed);
        let mut interceptor = vt_query::VtQueryInterceptor::with_colors(
            self.palette.clone(),
            self.color_reports.clone(),
        );
        interceptor.set_overrides(&handoff.colors);
        let replay = Replay::restore(
            handoff.cols,
            handoff.rows,
            self.scrollback_bytes,
            handoff.journal,
        );
        self.start(
            master,
            handoff.pid,
            handoff.cols,
            handoff.rows,
            replay,
            interceptor,
            handoff.pending,
            handoff.input,
        )
    }

    /// The program that runs `btmux` subcommands in this pane's shell: its
    /// `$BTMUX_BIN`, unless an upgrade replaced that binary.
    pub fn shell_bin(&self) -> String {
        match server_exe() {
            Some(exe) if self.bin.as_deref() != Some(exe) => {
                crate::session::manager::shell_single_quote(&exe.to_string_lossy())
            }
            _ => "\"$BTMUX_BIN\"".into(),
        }
    }

    /// Stop the reader and writer without consuming further output or
    /// input, for a handoff.
    pub fn stop_io(&self) {
        if let Some(stop) = &self.stop_reader {
            unsafe { libc::write(stop.as_raw_fd(), [0u8].as_ptr().cast(), 1) };
            // A full queue means the writer isn't idle.
            let _ = self.input_tx.0.try_send(PtyInput::Stop);
            if let Some(stopping) = self.stopping.lock().unwrap().as_mut() {
                stopping.requested = true;
            }
        }
    }

    /// Wait for the stopped reader and writer and export this pane's state.
    /// `Ok(None)` if the pane has no live shell; after an error, `recover`
    /// restarts it.
    pub fn export_handoff(
        &mut self,
        deadline: Instant,
    ) -> Result<Option<(RawFd, Handoff)>, String> {
        let slot = self.stopping.get_mut().unwrap();
        let Some(stopping) = slot.as_mut().filter(|stopping| stopping.requested) else {
            return Ok(None);
        };
        if !stopping.wait(deadline) {
            return Err("its reader or writer did not stop in time".into());
        }
        let input = stopping.input();
        let reader = stopping.reader.take();
        *slot = None;
        let (Some(reader), Some(pid), Some(master)) =
            (reader, *self.child.lock().unwrap(), &self.master)
        else {
            return Ok(None);
        };
        let (cols, rows) = *self.size.lock().unwrap();
        let journal = self.scrollback.lock().unwrap().snapshot();
        Ok(Some((
            master.as_raw_fd(),
            Handoff {
                pid,
                cols,
                rows,
                journal,
                title: self.title.lock().unwrap().clone(),
                cwd: self.cwd.lock().unwrap().clone(),
                spawn_cwd: self.spawn_cwd.clone(),
                color_reports: self.color_reports.load(Ordering::Relaxed),
                colors: reader.colors,
                pending: reader.pending,
                input,
                bin: self.bin.clone(),
            },
        )))
    }

    /// Restart the reader and writer stopped for a handoff that failed.
    pub fn resume(&mut self, handoff: Handoff) -> Result<(), String> {
        self.restart(&handoff.colors, handoff.pending, handoff.input)
    }

    /// Restart a reader and writer that `export_handoff` gave up on. One that
    /// still hasn't stopped by `deadline` loses its state (program-set colors,
    /// a partly read sequence) and finishes the chunk it holds.
    pub fn recover(&mut self, deadline: Instant) -> Result<(), String> {
        let Some(mut stopping) = self
            .stopping
            .get_mut()
            .unwrap()
            .take_if(|stopping| stopping.requested)
        else {
            return Ok(());
        };
        let stopped = stopping.wait(deadline);
        let input = stopping.input();
        let (colors, pending) = match stopping.reader.take() {
            Some(reader) => (reader.colors, reader.pending),
            // Ended at EOF: the shell exited.
            None if stopped => return Ok(()),
            None => {
                tracing::warn!(pane_id = %self.pane_id, "restarting a reader that did not stop");
                Default::default()
            }
        };
        self.restart(&colors, pending, input).inspect_err(|_| {
            if let Some(pid) = *self.child.lock().unwrap() {
                // Its waiter reaps it and removes the pane.
                unsafe { libc::kill(pid, libc::SIGHUP) };
            }
        })
    }

    fn restart(
        &mut self,
        colors: &[Option<colors::Rgb>],
        pending: Vec<u8>,
        input: Vec<u8>,
    ) -> Result<(), String> {
        let io = PtyIo::new(self.master.as_ref().ok_or("PTY has no master")?)?;
        let mut interceptor = vt_query::VtQueryInterceptor::with_colors(
            self.palette.clone(),
            self.color_reports.clone(),
        );
        interceptor.set_overrides(colors);
        self.run_io(io, interceptor, pending, input);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        &mut self,
        master: OwnedFd,
        pid: libc::pid_t,
        cols: u16,
        rows: u16,
        replay: Replay,
        interceptor: vt_query::VtQueryInterceptor,
        pending: Vec<u8>,
        input: Vec<u8>,
    ) -> Result<(), String> {
        // So a stalled program can't block the writer through a handoff.
        set_nonblocking(master.as_raw_fd()).map_err(|e| format!("failed to start PTY: {e}"))?;
        let io = PtyIo::new(&master)?;
        set_size(master.as_raw_fd(), cols, rows);

        self.shell_pid = Some(pid);
        *self.child.lock().unwrap() = Some(pid);
        let child = self.child.clone();
        let child_exit_tx = self.exit_tx.clone();
        let child_pane_id = self.pane_id;
        std::thread::spawn(move || {
            let mut status = 0;
            let reaped = loop {
                match unsafe { libc::waitpid(pid, &mut status, 0) } {
                    -1 if std::io::Error::last_os_error().kind()
                        == std::io::ErrorKind::Interrupted => {}
                    result => break result == pid,
                }
            };
            child.lock().unwrap().take();
            // Not our child: the reader reports the exit at EOF instead.
            if reaped {
                let _ = child_exit_tx.send(child_pane_id);
            }
        });

        // Store the master fd for foreground-process-group checks.
        *self.master_fd.lock().unwrap() = Some(master.as_raw_fd());
        self.master = Some(master);
        *self.scrollback.lock().unwrap() = replay;
        self.run_io(io, interceptor, pending, input);
        *self.size.lock().unwrap() = (cols, rows);
        *self.spawned.lock().unwrap() = true;
        Ok(())
    }

    /// Start the reader and writer threads.
    fn run_io(
        &mut self,
        io: PtyIo,
        interceptor: vt_query::VtQueryInterceptor,
        pending: Vec<u8>,
        input: Vec<u8>,
    ) {
        let PtyIo {
            mut reader,
            writer,
            stop_rx,
            stop_tx,
            writer_stop,
        } = io;
        let (input_tx, mut input_rx) = mpsc::channel::<PtyInput>(32);
        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
        let writer_stopped_tx = stopped_tx.clone();
        *self.stopping.get_mut().unwrap() = Some(Stopping {
            rx: stopped_rx,
            requested: false,
            reader: None,
            input: None,
        });
        self.stop_reader = Some(stop_tx);

        let mut output = OutputPipeline {
            interceptor,
            osc_parser: OscParser::new(self.meta_tx.clone()),
            response_tx: input_tx.clone(),
            pending_cpr_pgrps: self.pending_cpr_pgrps.clone(),
            master_fd: self.master_fd.clone(),
            title: self.title.clone(),
            cwd: self.cwd.clone(),
            scrollback: self.scrollback.clone(),
            output_tx: self.output_tx.clone(),
            pane_id: self.pane_id,
        };
        let exit_tx = self.exit_tx.clone();
        let pane_id = self.pane_id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut stopped = false;
            // Replies the input queue no longer took.
            let mut unsent = None;
            if let Err(replies) = output.feed(&pending) {
                unsent = Some(replies);
            } else {
                loop {
                    match wait_readable(reader.as_raw_fd(), stop_rx.as_raw_fd()) {
                        Ok(true) => {}
                        Ok(false) => {
                            stopped = true;
                            break;
                        }
                        Err(_) => break,
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Err(replies) = output.feed(&buf[..n]) {
                                unsent = Some(replies);
                                break;
                            }
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                            ) => {}
                        Err(_) => break,
                    }
                }
            }
            // The writer also closes the queue when it stops for a handoff.
            if stopped || (unsent.is_some() && is_readable(stop_rx.as_raw_fd())) {
                let (colors, pending) = output.interceptor.export();
                let _ = stopped_tx.send(Stopped::Reader(ReaderState {
                    colors,
                    pending,
                    unsent: unsent.unwrap_or_default(),
                }));
            } else {
                let _ = exit_tx.send(pane_id);
            }
        });

        // Dedicated writer — serializes input and backend DA replies,
        // filtering stale CPR responses from emulator input.
        let pending_cpr_pgrps_writer = self.pending_cpr_pgrps.clone();
        let master_fd_writer = self.master_fd.clone();
        std::thread::spawn(move || {
            let filter = |data: &[u8]| {
                Self::filter_stale_cpr(data, &pending_cpr_pgrps_writer, &master_fd_writer)
            };
            let mut unwritten = input;
            let mut reply: Option<oneshot::Sender<Result<(), String>>> = None;
            loop {
                match write_until_stopped(&writer, writer_stop.as_raw_fd(), &mut unwritten) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(e) => {
                        if let Some(reply) = reply {
                            let _ = reply.send(Err(format!("PTY input unavailable: {e}")));
                        }
                        return;
                    }
                }
                if let Some(reply) = reply.take() {
                    let _ = reply.send(Ok(()));
                }
                // `stop_io` can't queue `Stop` while the queue is full.
                if is_readable(writer_stop.as_raw_fd()) {
                    break;
                }
                match input_rx.blocking_recv() {
                    None => return,
                    Some(PtyInput::Stop) => break,
                    Some(PtyInput::Raw(data)) => unwritten = filter(&data),
                    Some(PtyInput::ShellCommand {
                        data,
                        shell_pid,
                        reply: sender,
                    }) => {
                        let foreground = master_fd_writer
                            .lock()
                            .unwrap()
                            .map(|fd| unsafe { libc::tcgetpgrp(fd) });
                        if foreground == Some(shell_pid) {
                            unwritten = data;
                            reply = Some(sender);
                        } else {
                            let _ = sender.send(Err(
                                "Cannot open file: the pane is not at a shell prompt".into(),
                            ));
                        }
                    }
                }
            }
            // Stopped for a handoff: the next server writes the rest.
            if let Some(reply) = reply {
                let _ = reply.send(Ok(()));
            }
            input_rx.close();
            while let Ok(input) = input_rx.try_recv() {
                match input {
                    PtyInput::Raw(data) => unwritten.extend(filter(&data)),
                    // Its foreground check can't carry over.
                    PtyInput::ShellCommand { reply, .. } => {
                        let _ = reply.send(Err("The btmux server is upgrading".into()));
                    }
                    PtyInput::Stop => {}
                }
            }
            let _ = writer_stopped_tx.send(Stopped::Writer(unwritten));
        });

        self.input_tx = InputSender(input_tx);
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
            .ok_or_else(|| "Cannot open file: pane shell is unavailable".to_string())?;
        self.input_tx.send_shell_command(data, shell_pid).await
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
            if let Some(fd) = *self.master_fd.lock().unwrap() {
                set_size(fd, cols, rows);
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

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // Invalidate the borrowed descriptor before `master` closes it and the
        // OS can reuse its number.
        if let Some(fd) = self.master_fd.lock().unwrap().take() {
            let pgrp = unsafe { libc::tcgetpgrp(fd) };
            if pgrp > 0 {
                unsafe {
                    libc::kill(-pgrp, libc::SIGHUP);
                }
            }
        }
        if let Some(pid) = *self.child.lock().unwrap() {
            unsafe { libc::kill(pid, libc::SIGHUP) };
        }
    }
}

fn set_size(fd: RawFd, cols: u16, rows: u16) {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) };
}

/// Turns PTY output into replies, replay, and broadcast.
struct OutputPipeline {
    interceptor: vt_query::VtQueryInterceptor,
    osc_parser: OscParser,
    response_tx: mpsc::Sender<PtyInput>,
    pending_cpr_pgrps: Arc<Mutex<VecDeque<libc::pid_t>>>,
    master_fd: Arc<Mutex<Option<RawFd>>>,
    title: Arc<Mutex<Option<String>>>,
    cwd: Arc<Mutex<Option<String>>>,
    scrollback: Arc<Mutex<Replay>>,
    output_tx: broadcast::Sender<Output>,
    pane_id: Uuid,
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
            PtyHandle::record_cpr_pgrp(&self.master_fd, &self.pending_cpr_pgrps);
        }

        self.osc_parser
            .feed(&result.scrollback, &self.title, &self.cwd);
        let mut sb = self.scrollback.lock().unwrap();
        sb.push(Output::Data(Bytes::from(result.scrollback)));
        let _ = self
            .output_tx
            .send(Output::Data(Bytes::from(result.broadcast)));
        sent
    }
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
                if !path.is_empty() {
                    *cwd.lock().unwrap() = Some(path);
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
                    let foreground = pane_ref
                        .master_fd
                        .lock()
                        .unwrap()
                        .map(|fd| unsafe { libc::tcgetpgrp(fd) });
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
            crate::session::manager::shell_single_quote(&exe.to_string_lossy())
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

#[cfg(test)]
mod osc_tests {
    use super::*;

    fn cwd_of(seq: &[u8]) -> Option<String> {
        let mut parser = OscParser::new(mpsc::unbounded_channel().0);
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
