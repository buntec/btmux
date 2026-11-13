mod agent_cli;
mod agent_hooks;
mod agent_launch;
mod agent_limits;
mod api;
mod api_client;
mod auth;
mod automation;
mod browser;
mod config;
// The desktop launcher also compiles this shared module.
#[allow(dead_code)]
mod discovery;
mod editor;
mod file_git;
mod file_git_ops;
mod file_search;
mod fish_integration;
mod fs_ops;
mod fzf;
mod git;
mod github;
#[cfg(unix)]
mod handoff;
#[cfg(windows)]
#[path = "handoff_windows.rs"]
mod handoff;
mod health;
mod mcp;
mod multipass;
mod pane_git;
mod paste_image;
mod persistence;
mod process;
#[cfg(test)]
mod protocol;
mod pty;
mod send_notification;
mod server;
mod service;
mod session;
mod shell;
mod system_info;
mod tailscale;
mod telemetry;
mod tmux_cli;
mod update_check;
mod vscode;
mod wallpaper;
mod widget;
mod worktree;
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
    if let Some(args) = fzf::args_when_linked() {
        std::process::exit(fzf::run(&args).await);
    }
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

    if let Some(config::SubCommand::OpenEditor { file, line, kind }) = args.command.as_ref() {
        std::process::exit(editor::run(file.as_deref(), *line, *kind).await);
    }

    if let Some(config::SubCommand::SendNotification { title, body, level }) = args.command.as_ref()
    {
        let code =
            send_notification::run(args.profile.as_deref(), *level, title, body.as_deref()).await;
        std::process::exit(code);
    }

    match args.command.as_ref() {
        Some(config::SubCommand::Claude { args }) => {
            std::process::exit(agent_launch::run(agent_launch::Agent::Claude, args))
        }
        Some(config::SubCommand::Codex { args }) => {
            std::process::exit(agent_launch::run(agent_launch::Agent::Codex, args))
        }
        Some(config::SubCommand::Pick(args)) => std::process::exit(widget::pick(args).await),
        Some(config::SubCommand::Fzf { args }) => std::process::exit(fzf::run(args).await),
        Some(config::SubCommand::GuestShell(args)) => {
            std::process::exit(multipass::guest_shell(args.clone()).await)
        }
        Some(config::SubCommand::Confirm {
            message,
            default_yes,
        }) => std::process::exit(widget::confirm(message, *default_yes).await),
        Some(config::SubCommand::Input { prompt, default }) => {
            std::process::exit(widget::input(prompt.as_deref(), default.as_deref()).await)
        }
        Some(config::SubCommand::Agents) => {
            std::process::exit(agent_cli::agents(args.profile.as_deref()).await)
        }
        Some(config::SubCommand::Wait {
            pane,
            states,
            timeout,
        }) => std::process::exit(
            agent_cli::wait(args.profile.as_deref(), pane, states, *timeout).await,
        ),
        Some(config::SubCommand::Prompt {
            pane,
            prompt,
            no_wait,
            timeout,
        }) => std::process::exit(
            agent_cli::prompt(
                args.profile.as_deref(),
                pane,
                prompt.as_deref(),
                !no_wait,
                *timeout,
            )
            .await,
        ),
        Some(config::SubCommand::Tmux(command)) => {
            std::process::exit(tmux_cli::run(args.profile.as_deref(), command.clone()).await)
        }
        _ => {}
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

    let log_dir = persistence::log_dir();
    if let Some(log_dir) = &log_dir {
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

    if let Some(config::SubCommand::GenerateFishTheme) = args.command {
        print!("{}", fish_integration::theme());
        return;
    }

    if let Some(config::SubCommand::InstallFishIntegration) = args.command {
        match fish_integration::install() {
            Ok(paths) => {
                for path in paths {
                    println!("Installed {}", path.display());
                }
            }
            Err(error) => {
                eprintln!("btmux: {error}");
                std::process::exit(1);
            }
        }
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

    if let Some(config::SubCommand::HandoffVersion) = args.command {
        println!("{} {}", handoff::VERSION, config::VERSION);
        return;
    }

    if let Some(config::SubCommand::Upgrade) = args.command {
        std::process::exit(handoff::run_cli(args.profile.as_deref()).await);
    }

    let mut inherited = handoff::take().unwrap_or_else(|error| {
        eprintln!("btmux: {error}");
        std::process::exit(2);
    });
    // Before an upgrade can replace the binary on disk.
    pty::server_exe();
    multipass::set_profile(args.profile.clone());
    #[cfg(unix)]
    process::raise_fd_limit();

    let config_path = config::config_path();
    let mut config_error = None;
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
                config_error = Some(e);
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
    browser::set_blocking(
        file_config.browser.block_ads,
        file_config.browser.block_autoplay,
    )
    .await;
    let (exit_tx, exit_rx) = tokio::sync::mpsc::unbounded_channel::<uuid::Uuid>();
    // PTY reader threads signal here when OSC title/cwd metadata changes so the
    // debounced task below re-broadcasts state without a full structural mutation.
    let (meta_tx, meta_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut manager = SessionManager::new(
        shell,
        file_config,
        exit_tx,
        meta_tx,
        args.port,
        args.shell.clone(),
    );
    if let Some(error) = config_error {
        manager.set_config_error(error);
    }
    let state: AppState = Arc::new(RwLock::new(manager));

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
    // Held until exit.
    #[cfg_attr(windows, allow(unused_variables))]
    let profile_lock = match inherited.as_mut().and_then(handoff::Inherited::take_lock) {
        Some(lock) => Some(lock),
        None => state_file.as_ref().map(|path| {
            persistence::ProfileLock::acquire(path).unwrap_or_else(|error| {
                eprintln!("btmux: {error}");
                std::process::exit(2);
            })
        }),
    };
    let auth = auth::load_token(state_file.as_deref())
        .and_then(|token| auth::Auth::new(token, &args.host, args.port, &args.public_url))
        .unwrap_or_else(|error| {
            eprintln!("btmux: {error}");
            std::process::exit(2);
        });
    let auth = Arc::new(auth);
    auth::load_guest_token(state_file.as_deref()).unwrap_or_else(|error| {
        eprintln!("btmux: {error}");
        std::process::exit(2);
    });
    multipass::configure_bridge(auth.clone(), &args.host, args.port);
    if let Some(dir) = state_file.as_ref().and_then(|p| p.parent()) {
        vscode::set_data_dir(dir.join("vscode"));
        browser::set_data_dir(dir.join("browser"));
    }
    let inherited_listener = if let Some(inherited) = inherited {
        Some(inherited.restore(&state).await)
    } else {
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
        None
    };

    spawn_pane_exit_handler(exit_rx, state.clone());
    spawn_agent_reaper(state.clone(), agent_manifest_dir());
    spawn_meta_change_handler(meta_rx, state.clone());
    update_check::spawn(state.clone());
    github::spawn(state.clone());

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
        executable: pty::server_exe().and_then(absolute_path),
        log_files: log_dir
            .filter(|_| file_level.trim() != "off")
            .and_then(|dir| absolute_path(&dir.join("btmux.log.*"))),
        instance: uuid::Uuid::new_v4().to_string(),
        pid: std::process::id(),
    };

    // Watch the config file and live-reload on change.
    if let Some(path) = config_path {
        spawn_config_watcher(path, state.clone());
    }

    let addr = format!("{}:{}", args.host, args.port);
    tracing::info!("btmux listening on {}", addr);

    let app = server::create_app(state.clone())
        .merge(server::info_routes(info))
        .merge(auth::routes(auth.clone()))
        .layer(axum::middleware::from_fn_with_state(
            auth.clone(),
            auth::protect,
        ));
    multipass::set_app(app.clone());
    if let Some(instance) = state.read().await.guest_instance() {
        multipass::restore_bridge(instance);
    }
    let upgraded = inherited_listener.is_some();
    let listener = match inherited_listener {
        Some(listener) => listener
            .set_nonblocking(true)
            .and_then(|()| tokio::net::TcpListener::from_std(listener)),
        None => tokio::net::TcpListener::bind(&addr).await,
    }
    .unwrap_or_else(|e| {
        eprintln!("error: cannot bind to {addr}: {e}");
        if e.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!(
                "hint: another instance of btmux (or another program) is already using this port."
            );
            eprintln!("      Use --port <PORT> to pick a different port.");
        }
        std::process::exit(1);
    });
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        handoff::configure(
            listener.as_raw_fd(),
            profile_lock.as_ref().map(|lock| lock.raw_fd()),
            state_file.clone(),
        );
    }

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

    if args.tailscale {
        if let Ok(address) = listener.local_addr() {
            let marker = state_file
                .as_ref()
                .map(|path| path.with_extension("tailscale"));
            let events = state.read().await.events().clone();
            tailscale::spawn(address, auth, marker, events);
        }
    }

    if !args.no_browser && !upgraded {
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
    ws::nvim::shutdown().await;
    vscode::shutdown().await;
    browser::shutdown().await;
    tailscale::shutdown().await;
    paste_image::shutdown();
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
            _ = server::shutdown_requested() => {},
        }
    }
    #[cfg(windows)]
    {
        let mut close = tokio::signal::windows::ctrl_close().expect("install Ctrl-Close handler");
        let mut shutdown =
            tokio::signal::windows::ctrl_shutdown().expect("install Ctrl-Shutdown handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = close.recv() => {},
            _ = shutdown.recv() => {},
            _ = desktop_parent_exit(parent_pid) => {},
            _ = server::shutdown_requested() => {},
        }
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

#[cfg(windows)]
async fn desktop_parent_exit(parent_pid: Option<u32>) {
    let Some(parent_pid) = parent_pid else {
        std::future::pending::<()>().await;
        return;
    };
    // Not `spawn_blocking`: the runtime waits for those on exit.
    let (exited, exit) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        process::wait_exit(parent_pid as process::Pid);
        let _ = exited.send(());
    });
    let _ = exit.await;
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
            if res.is_ok_and(|event| changes_config(event.kind)) {
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

/// inotify reports reads, so a reload would otherwise trigger the next one.
fn changes_config(kind: notify::EventKind) -> bool {
    use notify::event::{AccessKind, AccessMode};
    match kind {
        notify::EventKind::Access(kind) => kind == AccessKind::Close(AccessMode::Write),
        _ => true,
    }
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
        state.write().await.set_detector(detector.clone());
        let mut interval = tokio::time::interval(Duration::from_millis(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut process_checked = None;
        let mut manifests_checked = std::time::Instant::now();
        loop {
            interval.tick().await;
            let now = std::time::Instant::now();
            let reload = if now.duration_since(manifests_checked) >= Duration::from_secs(5) {
                manifests_checked = now;
                let mut next = detector.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let changed = next.reload();
                    (next, changed)
                })
                .await;
                match result {
                    Ok((loaded, changed)) => {
                        if changed {
                            state.write().await.set_detector(loaded.clone());
                        }
                        detector = loaded;
                        changed
                    }
                    Err(error) => {
                        tracing::error!(%error, "agent manifest reload failed; keeping current rules");
                        false
                    }
                }
            } else {
                false
            };
            let mut changed = false;
            if process_checked.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(1))
            {
                process_checked = Some(now);
                let pane_shells = state.read().await.pane_shells();
                let scan = tokio::task::spawn_blocking(move || {
                    let mut system = System::new().ok()?;
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
                                pane_process.process_group =
                                    crate::process::group(pane_process.pid as crate::process::Pid)
                                        .map(|group| group as u32);
                            }
                            pane_process
                        })
                        .collect();
                    let starts: HashMap<u32, u64> = processes
                        .iter()
                        .map(|process| (process.pid, process.start_time))
                        .collect();
                    let detected = detect_pane_agents(&processes, &pane_shells);
                    Some((starts, detected))
                })
                .await;
                // Without a scan, `alive` would report every agent dead.
                if let Ok(Some((starts, detected))) = scan {
                    let mut mgr = state.write().await;
                    let alive = |process: crate::session::agent::AgentProcess| {
                        starts.get(&process.pid) == Some(&process.start_time)
                    };
                    changed |= mgr.reap_stale_agents(now, alive);
                    changed |= mgr.update_detected_agents(&detected, alive);
                    changed |= mgr.end_agents_at_prompt(now, Duration::from_secs(3));
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

/// Held while config.toml is saved or reloaded, so a save's read, merge, write,
/// and install aren't interleaved with another's or the watcher's.
static CONFIG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn handle_config_reload(path: &std::path::Path, state: &AppState) {
    let _lock = CONFIG_LOCK.lock().await;
    // A save already loaded what it wrote.
    let text = tokio::fs::read_to_string(path).await.ok();
    {
        let mut mgr = state.write().await;
        if text.is_some_and(|text| mgr.is_saved_config(&text)) {
            return;
        }
        mgr.set_saved_config(None);
    }
    let file_config = match config::load_with_colors(path).await {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::error!("config reload failed: {} — keeping previous config", e);
            let mut mgr = state.write().await;
            let json = serde_json::to_string(&ServerMessage::Config {
                config: Box::new(mgr.set_config_error(e).clone()),
            })
            .unwrap();
            let _ = mgr.events().send(json);
            return;
        }
    };
    install_config(state, file_config, None, "Config reloaded").await;
    tracing::info!("config reloaded from {}", path.display());
}

/// Write the session-only overrides plus `update` into config.toml at `path`
/// and load it, which drops the overrides. Nothing is written unless the
/// result loads, remote palettes included.
pub(crate) async fn save_config(
    path: &std::path::Path,
    update: &config::ConfigUpdate,
    state: &AppState,
) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().await;
    let overrides = state.read().await.overrides_with(update);
    let saved = tokio::task::spawn_blocking({
        let path = path.to_path_buf();
        move || config::render_config(&path, &overrides)
    })
    .await
    .map_err(|e| e.to_string())??;
    let file_config = config::resolve_remote_colors(saved.config.clone())
        .await
        .map_err(|e| format!("Couldn't save settings: {e}"))?;
    let saved = tokio::task::spawn_blocking(move || saved.write().map(|()| saved))
        .await
        .map_err(|e| e.to_string())??;
    let message = format!("Saved to {}", path.display());
    install_config(state, file_config, Some(saved.text), &message).await;
    Ok(())
}

/// Install a loaded config.toml, dropping session-only overrides, and
/// broadcast it with a toast of `message`. `saved` is the text a save wrote.
async fn install_config(
    state: &AppState,
    file_config: config::FileConfig,
    saved: Option<String>,
    message: &str,
) {
    let blocking = (
        file_config.browser.block_ads,
        file_config.browser.block_autoplay,
    );
    let json = {
        let mut mgr = state.write().await;
        mgr.set_saved_config(saved);
        // Also drops any session-only overrides picked from the command palette.
        let client_config = mgr.set_file_config(file_config).clone();
        serde_json::to_string(&ServerMessage::Config {
            config: Box::new(client_config),
        })
        .unwrap()
    };

    let toast_json = serde_json::to_string(&ServerMessage::Toast {
        message: message.into(),
        level: ws::control::NotificationLevel::Info,
    })
    .unwrap();

    let mgr = state.read().await;
    let _ = mgr.events().send(json);
    let _ = mgr.events().send(toast_json);
    drop(mgr);
    browser::set_blocking(blocking.0, blocking.1).await;
}

#[cfg(test)]
mod tests {
    use super::{changes_config, log_directives, resolve_log_level};
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind};

    #[test]
    fn config_reads_do_not_reload() {
        assert!(!changes_config(EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!changes_config(EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(changes_config(EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(changes_config(EventKind::Modify(ModifyKind::Any)));
        assert!(changes_config(EventKind::Create(CreateKind::File)));
    }

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
    #[cfg(unix)]
    async fn screen_detection_and_ctrl_c_exit_work_without_hooks_or_viewers() {
        use super::*;
        use crate::session::AgentState;
        use tokio::sync::mpsc;
        let directory = std::env::temp_dir().join(format!("btmux-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("codex");
        // uutils' multicall cat (Ubuntu 26.04+) refuses to run as `codex`.
        let cat = ["/usr/bin/gnucat", "/bin/cat"]
            .into_iter()
            .find(|path| std::path::Path::new(path).exists())
            .unwrap();
        std::os::unix::fs::symlink(cat, &executable).unwrap();
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

    fn config_state() -> super::AppState {
        use super::{config, Arc, RwLock, SessionManager};
        let (exit_tx, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta_tx, _) = tokio::sync::mpsc::unbounded_channel();
        Arc::new(RwLock::new(SessionManager::new(
            "/bin/sh".into(),
            config::FileConfig::default(),
            exit_tx,
            meta_tx,
            8004,
            None,
        )))
    }

    #[tokio::test]
    async fn concurrent_saves_keep_every_change() {
        use super::config::ConfigUpdate;
        let dir = std::env::temp_dir().join(format!("btmux-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "# mine\n").unwrap();
        let state = config_state();
        let updates = [
            ConfigUpdate {
                animations: Some(false),
                ..ConfigUpdate::default()
            },
            ConfigUpdate {
                show_pane_titles: Some(false),
                ..ConfigUpdate::default()
            },
            ConfigUpdate {
                font_size: Some(15.0),
                ..ConfigUpdate::default()
            },
            ConfigUpdate {
                scrollback: Some(5000),
                ..ConfigUpdate::default()
            },
            ConfigUpdate {
                wallpaper_opacity: Some(0.5),
                ..ConfigUpdate::default()
            },
            ConfigUpdate {
                backdrop_blur: Some(3.0),
                ..ConfigUpdate::default()
            },
        ];
        let saves = updates.iter().map(|update| {
            let (path, state) = (path.clone(), state.clone());
            let update = update.clone();
            tokio::spawn(async move { super::save_config(&path, &update, &state).await })
        });
        for save in futures_util::future::join_all(saves).await {
            save.unwrap().unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for line in [
            "# mine",
            "animations = false",
            "show-pane-titles = false",
            "font-size = 15.0",
            "scrollback = 5000",
            "wallpaper-opacity = 0.5",
            "backdrop-blur = 3.0",
        ] {
            assert!(text.contains(line), "{line} missing from {text}");
        }
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["config.toml"]);
        let config = state.read().await.config().clone();
        assert!(!config.animations && !config.show_pane_titles);
        assert!(state.read().await.is_saved_config(&text));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn save_fails_without_writing_when_a_remote_palette_is_unavailable() {
        use super::{config, Arc};
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/dark.yml", listener.local_addr().unwrap());
        let up = Arc::new(AtomicBool::new(false));
        tokio::spawn({
            let up = up.clone();
            async move {
                let palette = include_str!("../extras/colors/btmux-default-dark.yml");
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096];
                    let _ = socket.read(&mut request).await;
                    let response = if up.load(Ordering::SeqCst) {
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{palette}",
                            palette.len()
                        )
                    } else {
                        "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("btmux-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        let original = format!("colors-dark = \"{url}\"\n");
        std::fs::write(&path, &original).unwrap();
        let state = config_state();
        let update = config::ConfigUpdate {
            console_level: Some("trace".into()),
            ..config::ConfigUpdate::default()
        };

        let error = super::save_config(&path, &update, &state)
            .await
            .unwrap_err();
        assert!(error.contains("503"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(!state.read().await.is_saved_config(&original));

        up.store(true, Ordering::SeqCst);
        super::save_config(&path, &update, &state).await.unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("console-level = \"trace\""), "{text}");
        let config = state.read().await.config().clone();
        assert_eq!(config.colors_dark.as_deref(), Some(url.as_str()));
        assert!(config.config_error.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
