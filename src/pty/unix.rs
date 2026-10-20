// Unix PTYs: the server owns the master fd, polls it with a stop pipe,
// and reaps the shell with waitpid.

use super::*;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd};
use std::time::Instant;

pub type Master = OwnedFd;
/// The master fd, for tcgetpgrp.
pub type Probe = RawFd;

pub fn foreground(fd: &Probe) -> Option<Pid> {
    match unsafe { libc::tcgetpgrp(*fd) } {
        pgrp if pgrp > 0 => Some(pgrp),
        _ => None,
    }
}

pub fn resize_master(master: &Master, cols: u16, rows: u16) {
    set_size(master.as_raw_fd(), cols, rows);
}

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
pub(super) struct ReaderState {
    colors: Vec<Option<colors::Rgb>>,
    pending: Vec<u8>,
    /// Replies that reached the input queue after the writer stopped.
    unsent: Vec<u8>,
}

/// A report from a reader or writer stopped for a handoff.
pub(super) enum Stopped {
    Reader(ReaderState),
    /// Input not yet written.
    Writer(Vec<u8>),
}

/// Collects the reports of a running reader and writer once told to stop.
pub(super) struct Stopping {
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
pub(super) struct PtyIo {
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

impl PtyHandle {
    pub(super) fn spawn(
        &mut self,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
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
        *self.probe.lock().unwrap() = Some(master.as_raw_fd());
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

        let mut output = self.output_pipeline(interceptor, input_tx.clone());
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
        let probe_writer = self.probe.clone();
        std::thread::spawn(move || {
            let filter = |data: &[u8]| {
                Self::filter_stale_cpr(data, &pending_cpr_pgrps_writer, &probe_writer)
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
                        let foreground = probe_writer.lock().unwrap().as_ref().and_then(foreground);
                        if foreground == Some(shell_pid) {
                            unwritten = data;
                            reply = Some(sender);
                        } else {
                            let _ = sender.send(Err("The pane is not at a shell prompt".into()));
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
}

impl OutputPipeline {
    /// Follow the cwd of a foreground shell, the pane's or one nested in it,
    /// until the shell reports it with OSC 7. Other programs (`make -C`)
    /// don't move it.
    pub(super) fn poll_cwd(&mut self) {
        if self.osc_parser.reported_cwd {
            return;
        }
        let Some(pgrp) = self.probe.lock().unwrap().as_ref().and_then(foreground) else {
            return;
        };
        let shell = match self.leader {
            Some((leader, shell)) if leader == pgrp => shell,
            _ => {
                let shell = Some(pgrp) == self.shell_pid
                    || crate::process::name(pgrp).is_some_and(|name| is_shell(&name));
                self.leader = Some((pgrp, shell));
                shell
            }
        };
        let Some(cwd) = shell.then(|| crate::process::cwd(pgrp)).flatten() else {
            return;
        };
        let cwd = cwd.to_string_lossy();
        let mut current = self.cwd.lock().unwrap();
        if current.as_deref() != Some(&*cwd) {
            *current = Some(cwd.into_owned());
            drop(current);
            let _ = self.osc_parser.meta_tx.send(());
        }
    }
}

/// Whether `name` is a shell's executable; login shells start with `-`, Nix
/// wrappers with `.` and end in `-wrapped`.
fn is_shell(name: &str) -> bool {
    let name = name.trim_start_matches(['-', '.']);
    let name = name.strip_suffix("-wrapped").unwrap_or(name);
    matches!(
        name,
        "bash"
            | "zsh"
            | "fish"
            | "sh"
            | "dash"
            | "ksh"
            | "mksh"
            | "yash"
            | "tcsh"
            | "csh"
            | "nu"
            | "elvish"
    )
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // Invalidate the borrowed descriptor before `master` closes it and the
        // OS can reuse its number.
        if let Some(fd) = self.probe.lock().unwrap().take() {
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
