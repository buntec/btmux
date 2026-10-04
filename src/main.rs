mod agent_hooks;
mod api;
mod auth;
mod config;
// The desktop launcher also compiles this shared module.
#[allow(dead_code)]
mod discovery;
mod file_git;
mod file_search;
mod fs_ops;
mod git;
mod mcp;
mod persistence;
#[cfg(test)]
mod protocol;
mod pty;
mod server;
mod service;
mod session;
mod ws;

use std::sync::Arc;
use std::time::Duration;

use clap::{CommandFactory, Parser};
use notify::{RecursiveMode, Watcher};
use time::UtcOffset;
use tokio::sync::RwLock;
use tracing_subscriber::fmt::time::OffsetTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use config::CliArgs;
use session::manager::SessionManager;
use ws::control::ServerMessage;

pub type AppState = Arc<RwLock<SessionManager>>;

const CONSOLE_LOG_ENV: &str = "BTMUX_CONSOLE_LOG";
const FILE_LOG_ENV: &str = "BTMUX_FILE_LOG";

fn resolve_log_level(configured: &str, environment: Option<String>) -> String {
    environment
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| configured.to_string())
}

fn log_directives(level: &str) -> String {
    match level.trim() {
        simple @ ("error" | "warn" | "info" | "debug" | "trace") => {
            format!("off,btmux={simple}")
        }
        directives => format!("off,{directives}"),
    }
}

fn make_filter(level: &str) -> EnvFilter {
    EnvFilter::try_new(log_directives(level)).unwrap_or_else(|_| EnvFilter::new("off,btmux=info"))
}

#[tokio::main]
async fn main() {
    let args = CliArgs::parse();

    if let Some(config::SubCommand::Completions { shell }) = args.command.as_ref() {
        clap_complete::generate(
            *shell,
            &mut CliArgs::command(),
            "btmux",
            &mut std::io::stdout(),
        );
        return;
    }

    // Parse config early (before full startup) so we can configure logging from
    // the [log] section. Failures here fall back to defaults silently — the real
    // config load below will log the error.
    let log_config = config::config_path()
        .and_then(|p| config::load(&p).ok())
        .map(|c| c.log)
        .unwrap_or_default();

    let console_level = resolve_log_level(
        &log_config.console_level,
        std::env::var(CONSOLE_LOG_ENV).ok(),
    );
    let file_level = resolve_log_level(&log_config.file_level, std::env::var(FILE_LOG_ENV).ok());
    let console_filter = make_filter(&console_level);
    let file_filter = make_filter(&file_level);

    let local_time = OffsetTime::new(
        UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC),
        time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3][offset_hour sign:mandatory]:[offset_minute]"
        ),
    );

    let console_layer = tracing_subscriber::fmt::layer().with_filter(console_filter);

    if let Some(log_dir) = persistence::log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "btmux.log");
        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(file_appender)
            .with_ansi(false)
            .with_timer(local_time)
            .with_filter(file_filter);
        tracing_subscriber::registry()
            .with(console_layer)
            .with(file_layer)
            .init();
    } else {
        tracing_subscriber::registry().with(console_layer).init();
    }

    if let Some(config::SubCommand::Version) = args.command {
        println!("btmux {}", config::VERSION);
        return;
    }

    if let Some(config::SubCommand::GenerateConfig) = args.command {
        print!("{}", config::generate_config_toml());
        return;
    }

    if let Some(config::SubCommand::GenerateClaudeCodeHooks) = args.command {
        print!("{}", agent_hooks::claude_code());
        return;
    }

    if let Some(config::SubCommand::GenerateCodexHooks) = args.command {
        print!("{}", agent_hooks::codex());
        return;
    }

    if let Some(config::SubCommand::GenerateGeminiCliHooks) = args.command {
        print!("{}", agent_hooks::gemini_cli());
        return;
    }

    if let Some(config::SubCommand::InstallClaudeCodeHooks) = args.command {
        install_agent_hooks(agent_hooks::Target::ClaudeCode);
        return;
    }

    if let Some(config::SubCommand::InstallCodexHooks) = args.command {
        install_agent_hooks(agent_hooks::Target::Codex);
        return;
    }

    if let Some(config::SubCommand::InstallGeminiCliHooks) = args.command {
        install_agent_hooks(agent_hooks::Target::GeminiCli);
        return;
    }

    if let Some(config::SubCommand::Install { print }) = args.command {
        service::install(&args, print);
        return;
    }

    if let Some(config::SubCommand::Uninstall) = args.command {
        service::uninstall();
        return;
    }

    if let Some(config::SubCommand::Restart) = args.command {
        service::restart();
        return;
    }

    let config_path = config::config_path();
    let file_config = match &config_path {
        Some(path) => match config::load_with_colors(path).await {
            Ok(cfg) => {
                if path.exists() {
                    tracing::info!("loaded config from {}", path.display());
                } else {
                    tracing::info!("no config at {} — using defaults", path.display());
                }
                cfg
            }
            Err(e) => {
                tracing::error!(
                    "failed to load config from {}: {} — using defaults",
                    path.display(),
                    e
                );
                config::FileConfig::default()
            }
        },
        None => {
            tracing::warn!(
                "could not resolve config dir (no XDG_CONFIG_HOME or HOME) — using defaults"
            );
            config::FileConfig::default()
        }
    };

    // CLI `--shell` wins over config.toml `shell`, which wins over $SHELL, then
    // the configured default shell.
    let shell = args
        .shell
        .clone()
        .unwrap_or_else(|| config::resolve_shell(file_config.shell.as_deref()));

    // PTY reader threads report a pane's id here when its shell exits (EOF). The
    // drain task below removes the pane and broadcasts the new state to all tabs.
    let (exit_tx, exit_rx) = tokio::sync::mpsc::unbounded_channel::<uuid::Uuid>();
    // PTY reader threads signal here when OSC title/cwd metadata changes so the
    // debounced task below re-broadcasts state without a full structural mutation.
    let (meta_tx, meta_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let state: AppState = Arc::new(RwLock::new(SessionManager::new(
        shell,
        file_config,
        exit_tx,
        meta_tx,
        args.port,
        args.shell.clone(),
    )));

    // Restore the saved session tree from disk if present; otherwise start with
    // a single default session. Process state can't be restored — each pane gets
    // a fresh shell, spawned lazily in its saved cwd.
    let state_file = match persistence::state_path(args.profile.as_deref()) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("btmux: {e}");
            std::process::exit(2);
        }
    };
    let _profile_lock = state_file.as_ref().map(|path| {
        persistence::ProfileLock::acquire(path).unwrap_or_else(|error| {
            eprintln!("btmux: {error}");
            std::process::exit(2);
        })
    });
    let auth = auth::load_token(state_file.as_deref())
        .and_then(|token| auth::Auth::new(token, &args.host, args.port, &args.public_url))
        .unwrap_or_else(|error| {
            eprintln!("btmux: {error}");
            std::process::exit(2);
        });
    let auth = Arc::new(auth);
    {
        let mut mgr = state.write().await;
        let restored = state_file
            .as_ref()
            .and_then(|p| persistence::load(p))
            .map(|snaps| mgr.restore_from_snapshots(snaps))
            .unwrap_or(0);
        if restored == 0 {
            mgr.create_session(Some("0".to_string())).await;
        } else if let Some(p) = &state_file {
            tracing::info!("restored {} session(s) from {}", restored, p.display());
        }
    }

    spawn_pane_exit_handler(exit_rx, state.clone());
    spawn_agent_reaper(state.clone(), agent_manifest_dir());
    spawn_meta_change_handler(meta_rx, state.clone());

    // Persist the session tree to disk on every state change (debounced).
    if let Some(path) = &state_file {
        spawn_state_saver(path.clone(), state.clone()).await;
    }

    let absolute_path = |path: &std::path::Path| {
        std::path::absolute(path)
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    };
    let info = server::ServerInfo {
        version: config::VERSION.to_string(),
        profile: args.profile.clone(),
        config_file: config_path.as_deref().and_then(absolute_path),
        state_file: state_file.as_deref().and_then(absolute_path),
        token_file: state_file
            .as_ref()
            .and_then(|path| absolute_path(&path.with_extension("token"))),
        token_source: if std::env::var("BTMUX_AUTH_TOKEN").is_ok() {
            "BTMUX_AUTH_TOKEN"
        } else {
            "token file"
        }
        .to_string(),
        listen_address: format!("{}:{}", args.host, args.port),
        executable: std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(absolute_path),
    };

    // Watch the config file and live-reload on change.
    if let Some(path) = config_path {
        spawn_config_watcher(path, state.clone());
    }

    let addr = format!("{}:{}", args.host, args.port);
    tracing::info!("btmux listening on {}", addr);

    let app = server::create_app(state.clone())
        .merge(server::info_routes(info))
        .layer(axum::middleware::from_fn_with_state(auth, auth::protect));
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        eprintln!("error: cannot bind to {addr}: {e}");
        if e.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!("hint: another instance of btmux (or another program) is already using this port.");
            eprintln!("      Use --port <PORT> to pick a different port.");
        }
        std::process::exit(1);
    });

    // Bundled desktop servers stop with their app, so only it lists them.
    let _registration = state_file
        .as_ref()
        .filter(|_| args.desktop_parent_pid.is_none())
        .and_then(|path| {
            match discovery::Registration::publish(
                path,
                listener.local_addr().ok()?,
                args.profile.clone(),
                auth::shell_token()?.to_string(),
            ) {
                Ok(registration) => registration,
                Err(error) => {
                    tracing::warn!("could not register server for desktop discovery: {error}");
                    None
                }
            }
        });

    if !args.no_browser {
        let url = format!("http://{}:{}", args.host, args.port);
        if let Err(e) = open::that(&url) {
            tracing::warn!("could not open browser: {}", e);
        }
    }

    let drain_timeout = if args.desktop_parent_pid.is_some() {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(2)
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown_signal(args.desktop_parent_pid).await;
        let _ = shutdown_tx.send(());
    });
    tokio::select! {
        result = serve => result.unwrap(),
        _ = async {
            let _ = shutdown_rx.await;
            tokio::time::sleep(drain_timeout).await;
        } => tracing::warn!("timed out waiting for connections to close"),
    }
    if let Some(path) = state_file {
        let snapshots = state.read().await.all_snapshots();
        if let Err(error) = persistence::save(&path, &snapshots) {
            tracing::warn!("failed to persist state to {}: {}", path.display(), error);
        }
    }
}

async fn shutdown_signal(parent_pid: Option<u32>) {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
            _ = desktop_parent_exit(parent_pid) => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = parent_pid;
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    }
}

#[cfg(unix)]
async fn desktop_parent_exit(parent_pid: Option<u32>) {
    let Some(parent_pid) = parent_pid else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if unsafe { libc::getppid() } as u32 != parent_pid {
            return;
        }
    }
}

/// Watch the config file's parent directory (so editor atomic rename-on-save is
/// caught) and, on change, re-load + re-resolve binds and broadcast the new
/// config to all connected control sockets. A parse error keeps the last good
/// config — see `handle_config_reload`.
fn spawn_config_watcher(path: std::path::PathBuf, state: AppState) {
    let Some(dir) = path.parent().map(|p| p.to_path_buf()) else {
        return;
    };
    if !dir.exists() {
        tracing::warn!(
            "config dir {} does not exist — live reload disabled",
            dir.display()
        );
        return;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::error!("failed to create config watcher: {}", e);
                return;
            }
        };

    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        tracing::error!("failed to watch {}: {}", dir.display(), e);
        return;
    }

    tokio::spawn(async move {
        // Keep the watcher alive for the lifetime of this task.
        let _watcher = watcher;
        while rx.recv().await.is_some() {
            // Debounce: editors often emit several events per save. Drain the
            // burst, then reload once.
            tokio::time::sleep(Duration::from_millis(100)).await;
            while rx.try_recv().is_ok() {}
            handle_config_reload(&path, &state).await;
        }
    });
}

fn install_agent_hooks(target: agent_hooks::Target) {
    match agent_hooks::install(target) {
        Ok(path) => println!("Installed btmux hooks in {}", path.display()),
        Err(error) => {
            eprintln!("btmux: {error}");
            std::process::exit(1);
        }
    }
}

/// Persist the session tree to disk whenever it changes. Every structural
/// mutation (and the cwd/title metadata handler) ends by broadcasting on
/// `events()`, so subscribing here gives us one signal per change. Debounced —
/// a burst of mutations collapses into a single write after a short quiet
/// period. A write failure is logged but never disrupts the session.
async fn spawn_state_saver(path: std::path::PathBuf, state: AppState) {
    // Subscribe before spawning so we don't miss events emitted between now and
    // the task's first poll.
    let mut events = state.read().await.events().subscribe();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(_) => {}
                // Lagged: we dropped some events but the next snapshot is still
                // current, so just save. Closed: sender gone, nothing left to do.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
            // Debounce: drain the rest of the burst, then save once.
            tokio::time::sleep(Duration::from_millis(250)).await;
            loop {
                match events.try_recv() {
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                }
            }
            let snapshots = {
                let mgr = state.read().await;
                mgr.all_snapshots()
            };
            let save_path = path.clone();
            if let Err(e) =
                tokio::task::spawn_blocking(move || persistence::save(&save_path, &snapshots))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()))
            {
                tracing::warn!("failed to persist state to {}: {}", path.display(), e);
            }
        }
    });
}

/// Drain OSC metadata-change signals and broadcast a fresh state snapshot.
/// Debounced: rapid OSC updates (e.g. many cwd changes during shell init) are
/// collapsed into one broadcast after a short quiet period.
fn spawn_meta_change_handler(
    mut meta_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    state: AppState,
) {
    tokio::spawn(async move {
        while meta_rx.recv().await.is_some() {
            // Drain burst, then broadcast once.
            tokio::time::sleep(Duration::from_millis(100)).await;
            while meta_rx.try_recv().is_ok() {}
            let mgr = state.read().await;
            ws::control::broadcast_state(&mgr);
        }
    });
}

/// Drain pane-exit notifications (a shell hit EOF) and, for each, remove the
/// pane — cascading up to window/session — then broadcast the new state to all
/// control sockets so every tab re-renders without the dead pane.
fn spawn_pane_exit_handler(
    mut exit_rx: tokio::sync::mpsc::UnboundedReceiver<uuid::Uuid>,
    state: AppState,
) {
    tokio::spawn(async move {
        while let Some(pane_id) = exit_rx.recv().await {
            let mut mgr = state.write().await;
            mgr.handle_pane_exit(pane_id).await;
            ws::control::broadcast_state(&mgr);
        }
    });
}

fn agent_manifest_dir() -> Option<std::path::PathBuf> {
    config::config_path().and_then(|path| path.parent().map(|p| p.join("agent-detection")))
}

fn spawn_agent_reaper(state: AppState, manifests: Option<std::path::PathBuf>) {
    use crate::session::agent::{agent_name, detect_pane_agents, PaneProcess};
    use crate::session::detection::Detector;
    use std::collections::HashMap;
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    tokio::spawn(async move {
        // Overrides cannot panic here; only a bad bundled manifest can.
        let Ok(mut detector) = tokio::task::spawn_blocking(move || Detector::new(manifests)).await
        else {
            tracing::error!("agent detection failed to start");
            return;
        };
        let mut interval = tokio::time::interval(Duration::from_millis(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut process_checked = None;
        let mut manifests_checked = std::time::Instant::now();
        loop {
            interval.tick().await;
            let now = std::time::Instant::now();
            let reload = if now.duration_since(manifests_checked) >= Duration::from_secs(5) {
                manifests_checked = now;
                let result = tokio::task::spawn_blocking(move || {
                    let changed = detector.reload();
                    (detector, changed)
                })
                .await;
                let Ok((loaded, changed)) = result else {
                    tracing::error!("agent manifest reload failed; detection stopped");
                    return;
                };
                detector = loaded;
                changed
            } else {
                false
            };
            let mut changed = false;
            if process_checked.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(1))
            {
                process_checked = Some(now);
                let pane_shells = state.read().await.pane_shells();
                let scan = tokio::task::spawn_blocking(move || {
                    let mut system = System::new();
                    system.refresh_processes_specifics(
                        ProcessesToUpdate::All,
                        true,
                        ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
                    );
                    let processes: Vec<PaneProcess> = system
                        .processes()
                        .values()
                        .map(|process| {
                            let mut pane_process = PaneProcess {
                                pid: process.pid().as_u32(),
                                parent: process.parent().map(|pid| pid.as_u32()),
                                start_time: process.start_time(),
                                name: process.name().to_string_lossy().into_owned(),
                                command: process
                                    .cmd()
                                    .iter()
                                    .map(|part| part.to_string_lossy().into_owned())
                                    .collect(),
                                process_group: None,
                            };
                            if agent_name(&pane_process).is_some() {
                                let group =
                                    unsafe { libc::getpgid(pane_process.pid as libc::pid_t) };
                                pane_process.process_group = (group > 0).then_some(group as u32);
                            }
                            pane_process
                        })
                        .collect();
                    let starts: HashMap<u32, u64> = processes
                        .iter()
                        .map(|process| (process.pid, process.start_time))
                        .collect();
                    let detected = detect_pane_agents(&processes, &pane_shells);
                    (starts, detected)
                })
                .await;
                if let Ok((starts, detected)) = scan {
                    let mut mgr = state.write().await;
                    let alive = |process: crate::session::agent::AgentProcess| {
                        starts.get(&process.pid) == Some(&process.start_time)
                    };
                    changed |= mgr.reap_stale_agents(now, alive);
                    changed |= mgr.update_detected_agents(&detected, alive);
                }
            }
            let mut mgr = state.write().await;
            changed |= mgr.scan_agent_screens(&detector, now, reload);
            if changed {
                ws::control::broadcast_state(&mgr);
            }
        }
    });
}

async fn handle_config_reload(path: &std::path::Path, state: &AppState) {
    let file_config = match config::load_with_colors(path).await {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::error!("config reload failed: {} — keeping previous config", e);
            let toast_json = serde_json::to_string(&ServerMessage::Toast {
                message: format!("Config error: {e}"),
                level: ws::control::ToastLevel::Error,
            })
            .unwrap();
            let mgr = state.read().await;
            let _ = mgr.events().send(toast_json);
            return;
        }
    };

    let json = {
        let mut mgr = state.write().await;
        // Also drops any session-only overrides picked from the command palette.
        let client_config = mgr.set_file_config(file_config).clone();
        serde_json::to_string(&ServerMessage::Config {
            config: Box::new(client_config),
        })
        .unwrap()
    };

    let toast_json = serde_json::to_string(&ServerMessage::Toast {
        message: "Config reloaded".into(),
        level: ws::control::ToastLevel::Info,
    })
    .unwrap();

    let mgr = state.read().await;
    let _ = mgr.events().send(json);
    let _ = mgr.events().send(toast_json);
    tracing::info!("config reloaded from {}", path.display());
}

#[cfg(test)]
mod tests {
    use super::{log_directives, resolve_log_level};

    #[test]
    fn environment_log_level_overrides_config_when_non_empty() {
        assert_eq!(
            resolve_log_level("warn", Some("debug".to_string())),
            "debug"
        );
        assert_eq!(resolve_log_level("warn", Some("  ".to_string())), "warn");
        assert_eq!(resolve_log_level("warn", None), "warn");
    }

    #[test]
    fn simple_levels_target_btmux_and_full_directives_are_preserved() {
        assert_eq!(log_directives("debug"), "off,btmux=debug");
        assert_eq!(
            log_directives("btmux=trace,tower_http=info"),
            "off,btmux=trace,tower_http=info"
        );
    }

    #[tokio::test]
    async fn screen_detection_and_ctrl_c_exit_work_without_hooks_or_viewers() {
        use super::*;
        use crate::session::AgentState;
        use tokio::sync::mpsc;
        let directory = std::env::temp_dir().join(format!("btmux-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("codex");
        std::os::unix::fs::symlink("/bin/cat", &executable).unwrap();
        let (exit_tx, _) = mpsc::unbounded_channel();
        let (meta_tx, _) = mpsc::unbounded_channel();
        let mut manager = SessionManager::new(
            "/bin/sh".into(),
            config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8044,
            None,
        );
        let session = manager.create_session(None).await;
        let pane_id = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let pane = manager.find_pane_mut(pane_id).unwrap();
        pane.pty.ensure_spawned(80, 24).unwrap();
        let input = pane.pty.input_tx.clone();
        let shell_pid = pane.pty.shell_pid().unwrap();
        // Titles from before detection are stale.
        let command = format!(
            "printf '\\033]2;Action Required\\007'; '{}'\r",
            executable.display()
        );
        input.send_wait(command.into_bytes()).await.unwrap();
        let state = Arc::new(RwLock::new(manager));
        spawn_agent_reaper(state.clone(), None);
        tokio::time::timeout(Duration::from_secs(8), async {
            while state.read().await.running_agent_panes().is_empty() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("process scan detects the agent");
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(
            state.read().await.agent_status(pane_id).unwrap().state,
            AgentState::Unknown
        );
        // The fake agent (cat) echoes the title back.
        input
            .send_wait(b"\x1b]2;Action Required\x07\r".to_vec())
            .await
            .unwrap();
        let detected = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if state
                    .read()
                    .await
                    .agent_status(pane_id)
                    .is_some_and(|status| status.state == AgentState::Blocked)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(
            detected.is_ok(),
            "screen manifest detects approval without hooks"
        );
        input.send_wait(vec![3]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if state.read().await.running_agent_panes().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("Ctrl-C clears agent presence without an end hook");
        let pane_screen = state
            .read()
            .await
            .find_pane(pane_id)
            .unwrap()
            .pty
            .screen_snapshot();
        assert!(pane_screen.is_none(), "screen parsing stops with the agent");
        assert_eq!(
            state
                .read()
                .await
                .find_pane(pane_id)
                .unwrap()
                .pty
                .shell_pid(),
            Some(shell_pid)
        );
        state.write().await.kill_pane(session, pane_id);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
