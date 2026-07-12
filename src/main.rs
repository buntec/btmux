mod api;
mod config;
mod file_git;
mod file_search;
mod fs_ops;
mod git;
mod mcp;
mod persistence;
mod pty;
mod server;
mod service;
mod session;
mod ws;

use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
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

fn make_filter(level: &str) -> EnvFilter {
    EnvFilter::try_new(format!("off,btmux={level}"))
        .unwrap_or_else(|_| EnvFilter::new("off,btmux=info"))
}

#[tokio::main]
async fn main() {
    // Parse config early (before full startup) so we can configure logging from
    // the [log] section. Failures here fall back to defaults silently — the real
    // config load below will log the error.
    let log_config = config::config_path()
        .and_then(|p| config::load(&p).ok())
        .map(|c| c.log)
        .unwrap_or_default();

    let console_filter = make_filter(&log_config.console_level);
    let file_filter = make_filter(&log_config.file_level);

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

    let args = CliArgs::parse();

    if let Some(config::SubCommand::Version) = args.command {
        println!("btmux {}", config::VERSION);
        return;
    }

    if let Some(config::SubCommand::GenerateConfig) = args.command {
        print!("{}", config::generate_config_toml());
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
        Some(path) => match config::load(path) {
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

    // CLI `--shell` wins over config.toml `shell`, which wins over $SHELL, then /bin/bash.
    let shell = args
        .shell
        .clone()
        .or_else(|| file_config.shell.clone())
        .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "/bin/bash".to_string());

    let client_config = config::resolve_binds(&file_config);

    // PTY reader threads report a pane's id here when its shell exits (EOF). The
    // drain task below removes the pane and broadcasts the new state to all tabs.
    let (exit_tx, exit_rx) = tokio::sync::mpsc::unbounded_channel::<uuid::Uuid>();
    // PTY reader threads signal here when OSC title/cwd metadata changes so the
    // debounced task below re-broadcasts state without a full structural mutation.
    let (meta_tx, meta_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let state: AppState = Arc::new(RwLock::new(SessionManager::new(
        shell,
        client_config,
        exit_tx,
        meta_tx,
        args.port,
    )));

    // Restore the saved session tree from disk if present; otherwise start with
    // a single default session. Process state can't be restored — each pane gets
    // a fresh shell, spawned lazily in its saved cwd.
    let state_file = persistence::state_path();
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
    spawn_meta_change_handler(meta_rx, state.clone());

    // Persist the session tree to disk on every state change (debounced).
    if let Some(path) = state_file {
        spawn_state_saver(path, state.clone()).await;
    }

    // Watch the config file and live-reload on change.
    if let Some(path) = config_path {
        spawn_config_watcher(path, state.clone());
    }

    let addr = format!("{}:{}", args.host, args.port);
    tracing::info!("btmux listening on {}", addr);

    let app = server::create_app(state);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        eprintln!("error: cannot bind to {addr}: {e}");
        if e.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!("hint: another instance of btmux (or another program) is already using this port.");
            eprintln!("      Use --port <PORT> to pick a different port.");
        }
        std::process::exit(1);
    });

    if !args.no_browser {
        let url = format!("http://{}:{}", args.host, args.port);
        if let Err(e) = open::that(&url) {
            tracing::warn!("could not open browser: {}", e);
        }
    }

    axum::serve(listener, app).await.unwrap();
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
            if let Err(e) = persistence::save(&path, &snapshots) {
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

async fn handle_config_reload(path: &std::path::Path, state: &AppState) {
    let file_config = match config::load(path) {
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

    let client_config = config::resolve_binds(&file_config);
    let json = {
        let mut mgr = state.write().await;
        if let Some(shell) = file_config.shell.clone() {
            mgr.set_shell(shell);
        }
        mgr.set_config(client_config.clone());
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
