//! Install/uninstall btmux as a per-user background service.
//!
//! The `install`/`uninstall` entry points detect the OS at runtime and delegate
//! to a platform backend. Today only macOS is implemented; other platforms print
//! a clear "not supported yet" message. Adding Linux (a systemd `--user` unit)
//! later means filling in `install_linux`/`uninstall_linux` and wiring them into
//! the `match` below — no CLI changes needed.
//!
//! ## macOS
//!
//! We register a **LaunchAgent** (per-user, `gui/<uid>` domain), not a system
//! LaunchDaemon: btmux spawns PTYs/shells as the logged-in user and is tied to
//! a login session, so a root-owned daemon would spawn root shells — wrong.
//!
//! Two environment gotchas drive the generated plist:
//!   1. launchd hands the process a near-empty environment — notably no `PATH`
//!      and no `$SHELL`. Panes spawn the shell *non-login* (see `pty::ensure_spawned`),
//!      so they inherit btmux's environment verbatim and never source `~/.zprofile`.
//!      We therefore bake the installing shell's `PATH` (and a `--shell`) into the
//!      plist so panes come up with a usable environment.
//!   2. The binary must live at a stable path: running out of `target/release`
//!      breaks the moment you `cargo clean` or rebuild. We resolve the *current*
//!      executable's absolute path and warn if it looks like a build artifact.

use std::path::{Path, PathBuf};

use crate::config::CliArgs;

/// launchd Label / reverse-DNS identifier for the agent. Also the plist filename.
const LABEL: &str = "com.btmux.server";

/// Entry point for `btmux install`. Dispatches on the host OS; `print` (macOS
/// only) emits the generated service unit to stdout instead of installing it.
pub fn install(args: &CliArgs, print: bool) {
    match std::env::consts::OS {
        "macos" => install_macos(args, print),
        other => unsupported(other),
    }
}

/// Entry point for `btmux uninstall`. Dispatches on the host OS.
pub fn uninstall() {
    match std::env::consts::OS {
        "macos" => uninstall_macos(),
        other => unsupported(other),
    }
}

/// Entry point for `btmux restart`. Dispatches on the host OS.
pub fn restart() {
    match std::env::consts::OS {
        "macos" => restart_macos(),
        other => unsupported(other),
    }
}

/// No service backend for this OS yet. Kept as a single exit point so adding a
/// platform is just another arm in the `install`/`uninstall` match above.
fn unsupported(os: &str) -> ! {
    fail(&format!(
        "installing btmux as a service is not supported on {os} yet (only macOS). \
         Run btmux directly, or under your platform's service manager."
    ));
}

/// macOS `install`. When `print` is true we emit the plist to stdout and do
/// nothing else (useful for inspection / piping).
fn install_macos(args: &CliArgs, print: bool) {
    let exe = match current_exe() {
        Ok(p) => p,
        Err(e) => fail(&format!("cannot resolve the btmux binary path: {e}")),
    };

    let shell = resolve_shell(args);
    let path_env = std::env::var("PATH").unwrap_or_default();
    let plist = render_plist(&exe, args, &shell, &path_env);

    if print {
        print!("{plist}");
        return;
    }

    // Warn (don't block) if installing the throwaway build-artifact binary.
    if exe.components().any(|c| c.as_os_str() == "target") {
        eprintln!(
            "warning: installing from a build-artifact path:\n  {}\n\
             A `cargo clean` or rebuild will break the service. Consider copying\n\
             the binary somewhere stable (e.g. ~/.local/bin/btmux) and running\n\
             `install` from there.\n",
            exe.display()
        );
    }

    let plist_path = match plist_path() {
        Some(p) => p,
        None => fail("cannot resolve ~/Library/LaunchAgents (is $HOME set?)"),
    };

    if let Some(dir) = plist_path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            fail(&format!("cannot create {}: {e}", dir.display()));
        }
    }
    if let Err(e) = std::fs::write(&plist_path, &plist) {
        fail(&format!("cannot write {}: {e}", plist_path.display()));
    }
    println!("wrote {}", plist_path.display());

    // Load it into the per-user GUI domain.
    let domain = gui_domain();
    let service_target = format!("{domain}/{LABEL}");
    // `bootout` first so re-running the installer (e.g. after a port change)
    // replaces a stale registration rather than failing "already loaded".
    run_launchctl(
        &["bootout", &service_target],
        /* ignore_failure = */ true,
    );
    // `enable` before `bootstrap`: a previously-disabled agent would otherwise
    // refuse to bootstrap. This is a no-op for a never-seen label.
    run_launchctl(&["enable", &service_target], true);
    if !run_launchctl(
        &["bootstrap", &domain, plist_path.to_string_lossy().as_ref()],
        false,
    ) {
        fail("launchctl bootstrap failed (see output above)");
    }

    println!(
        "btmux service installed and started.\n\n\
         It is now running at http://{}:{} and will start at login.\n\n\
           Status:  launchctl print {service_target}\n\
           Logs:    tail -f {}\n\
           Stop:    btmux uninstall\n",
        args.host,
        args.port,
        log_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );
}

/// macOS `restart`: signal launchd to kill and relaunch the agent.
fn restart_macos() {
    let service_target = format!("{}/{LABEL}", gui_domain());
    if !run_launchctl(&["kickstart", "-k", &service_target], false) {
        fail("failed to restart the btmux service — is it installed?");
    }
    println!("btmux service restarted.");
}

/// macOS `uninstall`: unload the agent and remove its plist.
fn uninstall_macos() {
    let plist_path = match plist_path() {
        Some(p) => p,
        None => fail("cannot resolve ~/Library/LaunchAgents (is $HOME set?)"),
    };

    let service_target = format!("{}/{LABEL}", gui_domain());
    // Best-effort unload; the agent may already be stopped.
    run_launchctl(&["bootout", &service_target], true);

    match std::fs::remove_file(&plist_path) {
        Ok(()) => println!("removed {}", plist_path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!("no plist at {} — nothing to remove", plist_path.display());
        }
        Err(e) => fail(&format!("cannot remove {}: {e}", plist_path.display())),
    }
    println!("btmux service uninstalled.");
}

/// The shell to bake into the plist, using the same fallback chain as the
/// server: CLI `--shell` > config.toml `shell` > $SHELL > /bin/bash.
fn resolve_shell(args: &CliArgs) -> String {
    args.shell
        .clone()
        .or_else(|| {
            crate::config::config_path()
                .and_then(|p| crate::config::load(&p).ok())
                .and_then(|c| c.shell)
        })
        .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "/bin/bash".to_string())
}

/// Build the LaunchAgent plist. `RunAtLoad` starts it now and at login;
/// `KeepAlive` restarts it on crash. `--no-browser` is mandatory for a headless
/// service. PATH/SHELL are injected so spawned (non-login) shells have a usable
/// environment despite launchd's sparse default.
fn render_plist(exe: &Path, args: &CliArgs, shell: &str, path_env: &str) -> String {
    let log = log_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "/tmp/btmux.log".to_string());

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
        <string>--no-browser</string>
        <string>--host</string>
        <string>{host}</string>
        <string>--port</string>
        <string>{port}</string>
        <string>--shell</string>
        <string>{shell}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path}</string>
        <key>SHELL</key>
        <string>{shell}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
        label = LABEL,
        exe = xml_escape(&exe.to_string_lossy()),
        host = xml_escape(&args.host),
        port = args.port,
        shell = xml_escape(shell),
        path = xml_escape(path_env),
        log = xml_escape(&log),
    )
}

/// Resolve the running binary to an absolute path, following symlinks.
fn current_exe() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

/// `~/Library/LaunchAgents/com.btmux.server.plist`.
fn plist_path() -> Option<PathBuf> {
    home().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist"))
    })
}

/// `~/Library/Logs/btmux.log` — where launchd redirects stdout/stderr.
fn log_path() -> Option<PathBuf> {
    home().map(|h| h.join("Library").join("Logs").join("btmux.log"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The per-user GUI launchd domain, e.g. `gui/501`.
fn gui_domain() -> String {
    // Safe: getuid() always succeeds and has no error mode.
    let uid = unsafe { libc::getuid() };
    format!("gui/{uid}")
}

/// Run `launchctl` with the given args. Returns whether it succeeded. When
/// `ignore_failure` is set, a non-zero exit is swallowed (used for the
/// best-effort `bootout`/`enable` calls); otherwise output is surfaced.
fn run_launchctl(args: &[&str], ignore_failure: bool) -> bool {
    match std::process::Command::new("launchctl").args(args).output() {
        Ok(out) => {
            if out.status.success() {
                return true;
            }
            if !ignore_failure {
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !stderr.trim().is_empty() {
                    eprintln!("launchctl {}: {}", args.join(" "), stderr.trim());
                }
            }
            false
        }
        Err(e) => {
            if !ignore_failure {
                eprintln!("failed to run launchctl: {e}");
            }
            false
        }
    }
}

/// Escape the five XML predefined entities so paths/values are plist-safe.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Print an error to stderr and exit non-zero — matches the other subcommands.
fn fail(msg: &str) -> ! {
    eprintln!("btmux: {msg}");
    std::process::exit(1);
}
