// Windows PTYs: a ConPTY pseudoconsole with blocking pipe I/O. Closing the
// pseudoconsole ends the reader and the programs attached to it.

use super::*;
use crate::shell::Dialect;
use portable_pty::{ChildKiller, MasterPty};
use std::io::{Read, Write};

pub struct Master {
    /// Taken (closing the pseudoconsole) once the shell exits.
    pty: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

/// Finds the foreground program: the shell's newest child, or from OSC 133
/// marks for shells whose programs aren't its Windows children (Git Bash
/// starts them from short-lived forks; WSL's are Linux processes).
pub struct Probe {
    shell: Pid,
    prompt: Option<Arc<AtomicU32>>,
}

pub fn foreground(probe: &Probe) -> Option<Pid> {
    let Some(prompt) = &probe.prompt else {
        return crate::process::foreground(probe.shell);
    };
    match prompt.load(Ordering::Relaxed) {
        0 => None,
        // A pseudo group per command.
        state if state % 2 == 0 => Some(-(state as Pid)),
        _ => Some(probe.shell),
    }
}

/// Report PowerShell's location with OSC 7 before each prompt, wrapping the
/// prompt from the user's profile. PowerShell starts in `$PSHOME` when its
/// directory's name has wildcards (`[1]`).
const POWERSHELL_CWD: &str = r#"if ($PWD.ProviderPath -eq $PSHOME) {
  Set-Location -LiteralPath ([Environment]::CurrentDirectory)
}
$global:__btmux_prompt = $function:prompt
function global:prompt {
  $l = $ExecutionContext.SessionState.Path.CurrentLocation
  if ($l.Provider.Name -eq 'FileSystem') {
    $p = $l.ProviderPath.Replace('\', '/').Replace('%', '%25').Replace(' ', '%20')
    [Console]::Write("$([char]27)]7;file://localhost/$p$([char]7)")
  }
  & $global:__btmux_prompt
}"#;

/// bash hooks for Git Bash (drives under `/`, `cygpath`) and WSL (`/mnt/`,
/// `wslpath`): OSC 7 with the Windows path before each prompt, and OSC 133
/// marks, the prompt's only while `PS0` still marks commands. Prompt hooks
/// after it still see the command's `$?`.
fn bash_prompt_command(mount: &str, convert: &str) -> String {
    let n = mount.len();
    format!(
        "__btmux_s=$?; __btmux_prompt() {{ local p=$PWD d; case $p in \
         {mount}[A-Za-z]|{mount}[A-Za-z]/*) d=${{p:{n}:1}}; p=${{d^^}}:/${{p:{}}};; \
         *) p=$({convert} -m \"$p\" 2>/dev/null);; esac; p=${{p//\\%/%25}}; \
         [[ -n $p ]] && printf '\\e]7;file://localhost/%s\\a' \"${{p// /%20}}\"; \
         [[ $PS0 == *']133;C'* ]] && printf '\\e]133;A\\a'; return $1; }}; \
         __btmux_prompt $__btmux_s",
        n + 2
    )
}

const BASH_PS0: &str = r"\e]133;C\a";

/// What WSL passes in from Windows; `p` translates paths.
const WSL_ENV: [&str; 10] = [
    "PROMPT_COMMAND/u",
    "PS0/u",
    "TERM/u",
    "COLORTERM/u",
    "TERM_PROGRAM/u",
    "TERM_PROGRAM_VERSION/u",
    "BTMUX_PANE_ID/u",
    "BTMUX_API_URL/u",
    "BTMUX_AUTH_TOKEN/u",
    "BTMUX_BIN/pu",
];

/// Shell integration for `dialect`; new shells start in the home directory
/// rather than the server's.
pub fn integrate_shell(cmd: &mut CommandBuilder, dialect: Dialect, home: bool) {
    match dialect {
        Dialect::PowerShell => cmd.args(["-NoExit", "-Command", POWERSHELL_CWD]),
        Dialect::Cmd => {
            let prompt = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
            cmd.env("PROMPT", format!("$E]7;file://localhost/$P$E\\{prompt}"));
        }
        Dialect::Posix => {
            cmd.env("PROMPT_COMMAND", bash_prompt_command("/", "cygpath"));
            cmd.env("PS0", BASH_PS0);
        }
        Dialect::Wsl => {
            cmd.env("PROMPT_COMMAND", bash_prompt_command("/mnt/", "wslpath"));
            cmd.env("PS0", BASH_PS0);
            let mut vars: Vec<_> = cmd
                .get_env("WSLENV")
                .map(|vars| vars.to_string_lossy().into_owned())
                .into_iter()
                .filter(|vars| !vars.is_empty())
                .collect();
            vars.extend(WSL_ENV.map(String::from));
            cmd.env("WSLENV", vars.join(":"));
        }
    }
    if let Some(home) = dirs::home_dir().filter(|_| home) {
        cmd.cwd(home);
    }
}

pub fn resize_master(master: &Master, cols: u16, rows: u16) {
    if let Some(pty) = master.pty.lock().unwrap().as_ref() {
        let _ = pty.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

impl PtyHandle {
    pub(super) fn spawn(
        &mut self,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open PTY: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to start PTY: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to start PTY: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;
        drop(pair.slave);
        let pid = child
            .process_id()
            .and_then(|pid| pid.try_into().ok())
            .ok_or("spawned shell has no pid")?;
        let pty = Arc::new(Mutex::new(Some(pair.master)));

        self.shell_pid = Some(pid);
        *self.child.lock().unwrap() = Some(pid);
        let child_slot = self.child.clone();
        let child_pty = pty.clone();
        let exit_tx = self.exit_tx.clone();
        let pane_id = self.pane_id;
        let killer = child.clone_killer();
        std::thread::spawn(move || {
            let _ = child.wait();
            child_slot.lock().unwrap().take();
            // Ends the reader: ConPTY keeps its output open until closed.
            drop(child_pty.lock().unwrap().take());
            let _ = exit_tx.send(pane_id);
        });

        *self.probe.lock().unwrap() = Some(Probe {
            shell: pid,
            prompt: matches!(self.dialect, Dialect::Posix | Dialect::Wsl)
                .then(|| self.prompt.clone()),
        });
        self.master = Some(Master {
            pty,
            killer: Mutex::new(killer),
        });
        *self.scrollback.lock().unwrap() = Replay::new(cols, rows, self.scrollback_bytes);
        let interceptor = vt_query::VtQueryInterceptor::with_colors(
            self.palette.clone(),
            self.color_reports.clone(),
        );
        self.run_io(reader, writer, interceptor);
        *self.size.lock().unwrap() = (cols, rows);
        *self.spawned.lock().unwrap() = true;
        Ok(())
    }

    /// Start the reader and writer threads.
    fn run_io(
        &mut self,
        mut reader: Box<dyn Read + Send>,
        mut writer: Box<dyn Write + Send>,
        interceptor: vt_query::VtQueryInterceptor,
    ) {
        let (input_tx, mut input_rx) = mpsc::channel::<PtyInput>(32);
        let mut output = self.output_pipeline(interceptor, input_tx.clone());
        let exit_tx = self.exit_tx.clone();
        let pane_id = self.pane_id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut first = true;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut chunk = &buf[..n];
                        if std::mem::take(&mut first) {
                            chunk = output.answer_startup_query(chunk);
                        }
                        if output.feed(chunk).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = exit_tx.send(pane_id);
        });

        // Dedicated writer — serializes input and backend replies, filtering
        // stale CPR responses from emulator input.
        let pending_cpr_pgrps = self.pending_cpr_pgrps.clone();
        let probe = self.probe.clone();
        std::thread::spawn(move || {
            while let Some(input) = input_rx.blocking_recv() {
                let result = match input {
                    PtyInput::Raw(data) => {
                        writer.write_all(&Self::filter_stale_cpr(&data, &pending_cpr_pgrps, &probe))
                    }
                    PtyInput::ShellCommand {
                        data,
                        shell_pid,
                        reply,
                    } => {
                        let state = probe
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|probe| (foreground(probe), probe.prompt.is_some()));
                        let error = match state {
                            Some((Some(pid), _)) if pid == shell_pid => None,
                            Some((None, true)) => Some("The pane's shell doesn't mark its prompt"),
                            _ => Some("The pane is not at a shell prompt"),
                        };
                        if let Some(error) = error {
                            let _ = reply.send(Err(error.into()));
                            continue;
                        }
                        let result = writer.write_all(&data);
                        let _ = reply.send(
                            result
                                .as_ref()
                                .map(|_| ())
                                .map_err(|e| format!("PTY input unavailable: {e}")),
                        );
                        result
                    }
                };
                if result.and_then(|()| writer.flush()).is_err() {
                    return;
                }
            }
        });

        self.input_tx = InputSender(input_tx);
    }
}

impl OutputPipeline {
    /// Answer ConPTY's startup cursor query (`PSEUDOCONSOLE_INHERIT_CURSOR`):
    /// the shell waits for it, and a pane may have no viewer to reply.
    fn answer_startup_query<'a>(&self, chunk: &'a [u8]) -> &'a [u8] {
        let Some(rest) = chunk.strip_prefix(b"\x1b[6n") else {
            return chunk;
        };
        // Recorded so the stale-CPR filter lets the reply through.
        PtyHandle::record_cpr_pgrp(&self.probe, &self.pending_cpr_pgrps);
        let _ = self
            .response_tx
            .try_send(PtyInput::Raw(b"\x1b[1;1R".to_vec()));
        rest
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.probe.lock().unwrap().take();
        if let Some(master) = &self.master {
            if self.child.lock().unwrap().is_some() {
                let _ = master.killer.lock().unwrap().kill();
            }
            // Closing the pseudoconsole ends the programs attached to it.
            drop(master.pty.lock().unwrap().take());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for(condition: impl Fn() -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !condition() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn git_bash_reports_its_directory_and_prompt() {
        let bash = r"C:\Program Files\Git\bin\bash.exe";
        if !Path::new(bash).is_file() {
            return;
        }
        let env = PtyEnv {
            exit_tx: mpsc::unbounded_channel().0,
            meta_tx: mpsc::unbounded_channel().0,
            port: 8044,
            palette: colors::SharedPalette::default(),
        };
        let mut pane = PtyHandle::new_with_cwd(bash, Uuid::new_v4(), &env, None, 100);
        assert_eq!(pane.dialect(), Dialect::Posix);
        pane.ensure_spawned(80, 24).unwrap();
        let shell = pane.shell_pid.unwrap();
        wait_for(|| pane.foreground_pgrp() == Some(shell)).await;

        pane.input_tx.send(b"cd /c/Windows\r".to_vec()).unwrap();
        wait_for(|| pane.cwd.lock().unwrap().as_deref() == Some("C:/Windows")).await;

        // Windows doesn't show `sleep` as the shell's child.
        pane.input_tx.send(b"sleep 5\r".to_vec()).unwrap();
        wait_for(|| pane.foreground_pgrp() != Some(shell)).await;
        let result = pane.send_shell_command(b"echo x\r".to_vec()).await;
        assert!(result.unwrap_err().contains("not at a shell prompt"));
    }
}
