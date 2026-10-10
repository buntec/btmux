use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use std::ffi::CStr;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::webview::cookie::SameSite;
use tauri::webview::{Cookie, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// Shared with the backend; only the launcher reads registrations.
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../src/discovery.rs"]
mod discovery;
mod servers;

const SWITCH_SERVER: &str = "switch-server";

#[derive(Default)]
struct Server {
    child: Mutex<Option<CommandChild>>,
    // The bundled server, once ready. It does not publish a registration.
    private: Mutex<Option<discovery::RunningServer>>,
    choices: Mutex<Vec<discovery::RunningServer>>,
    // Bumped on every navigation so stale watchdogs stop.
    connection: AtomicU64,
    picker: OnceLock<Url>,
}

#[derive(serde::Serialize)]
struct ServerChoice {
    address: String,
    profile: String,
    url: String,
    bundled: bool,
}

#[tauri::command]
async fn discover_servers(state: State<'_, Server>) -> Result<Vec<ServerChoice>, String> {
    let private = state.private.lock().unwrap().clone();
    let bundled = private.as_ref().map(|server| server.address);
    let servers = tauri::async_runtime::spawn_blocking(move || {
        let mut servers = servers::discover()?;
        servers.extend(private.filter(servers::ready));
        Ok::<_, String>(servers)
    })
    .await
    .map_err(|_| "Could not look for running btmux servers.".to_string())??;
    let choices = servers
        .iter()
        .map(|server| ServerChoice {
            address: server.address.to_string(),
            profile: server.profile.clone().unwrap_or_else(|| "default".into()),
            url: format!("http://{}/", server.address),
            bundled: Some(server.address) == bundled,
        })
        .collect();
    *state.choices.lock().unwrap() = servers;
    Ok(choices)
}

fn show_picker(window: &WebviewWindow, reason: &str) {
    let state = window.state::<Server>();
    state.connection.fetch_add(1, Ordering::SeqCst);
    if let Some(picker) = state.picker.get() {
        let mut url = picker.clone();
        url.set_query(Some(&format!("return={reason}")));
        let _ = window.navigate(url);
    }
}

// Return to the picker once the connected server stops answering.
fn watch(window: WebviewWindow, server: discovery::RunningServer) {
    let generation = window.state::<Server>().connection.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut failures = 0;
        while failures < 3 {
            std::thread::sleep(Duration::from_secs(2));
            if window.state::<Server>().connection.load(Ordering::SeqCst) != generation {
                return;
            }
            failures = if servers::ready(&server) {
                0
            } else {
                failures + 1
            };
        }
        show_picker(&window, "lost");
    });
}

fn open_server(window: &WebviewWindow, server: &discovery::RunningServer) -> Result<(), String> {
    // IPv6 needs the bare form: WKWebView ignores a "[::1]" domain.
    let domain = server.address.ip().to_string();
    let cookie_name = format!("btmux_auth_{}", server.address.port());
    let cookie = Cookie::build((cookie_name.clone(), server.token.clone()))
        .domain(domain)
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();
    window
        .set_cookie(cookie)
        .map_err(|_| "Could not authenticate btmux.".to_string())?;
    let cookies = window
        .cookies()
        .map_err(|_| "Could not authenticate btmux.".to_string())?;
    if !cookies
        .iter()
        .any(|cookie| cookie.name() == cookie_name && cookie.value() == server.token)
    {
        return Err("Could not authenticate btmux.".into());
    }
    let url = format!("http://{}/", server.address).parse().unwrap();
    window
        .state::<Server>()
        .connection
        .fetch_add(1, Ordering::SeqCst);
    window
        .navigate(url)
        .map_err(|_| "Could not open btmux.".to_string())?;
    watch(window.clone(), server.clone());
    Ok(())
}

#[tauri::command]
async fn connect_server(
    window: WebviewWindow,
    state: State<'_, Server>,
    address: String,
) -> Result<(), String> {
    let server = state
        .choices
        .lock()
        .unwrap()
        .iter()
        .find(|server| server.address.to_string() == address)
        .cloned()
        .ok_or("This server is no longer listed. Refresh the server list.")?;
    tauri::async_runtime::spawn_blocking(move || {
        if !servers::ready(&server) {
            return Err("This server is no longer available. Refresh the server list.".into());
        }
        open_server(&window, &server)
    })
    .await
    .map_err(|_| "Could not connect to btmux.".to_string())?
}

fn stop_server(child: CommandChild) {
    #[cfg(unix)]
    if unsafe { libc::kill(child.pid() as i32, libc::SIGTERM) } != 0 {
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    let _ = child.kill();
}

fn start_private_server(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<Server>();
    let running = state.private.lock().unwrap().clone();
    if let Some(server) = running
        && servers::ready(&server)
    {
        return open_server(&window, &server);
    }
    let port = unused_loopback_port().map_err(|_| "Could not choose a server port.".to_string())?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut sidecar = app
        .shell()
        .sidecar("btmux")
        .map_err(|_| "Could not find the bundled btmux server.".to_string())?;
    // Probe the login shell before locking; it can take seconds.
    #[cfg(target_os = "macos")]
    if let Some(shell) = login_shell() {
        // GUI launches miss PATH additions from interactive shell startup.
        if let Some(path) = login_path(&shell) {
            sidecar = sidecar.env("PATH", path);
        }
        if std::env::var_os("SHELL").is_none() {
            sidecar = sidecar.env("SHELL", shell);
        }
    }
    let mut owned = state.child.lock().unwrap();
    if owned.is_some() {
        return Err("The desktop server is already starting.".into());
    }
    let (mut events, child) = sidecar
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--profile",
            "desktop",
            "--no-browser",
            "--desktop-parent-pid",
            &std::process::id().to_string(),
        ])
        .env("BTMUX_AUTH_TOKEN", &token)
        .spawn()
        .map_err(|_| "Could not start the bundled btmux server.".to_string())?;
    let pid = child.pid();
    *owned = Some(child);
    drop(owned);
    let (exited_tx, exited_rx) = std::sync::mpsc::channel();
    let events_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    eprintln!("btmux server exited: {:?}", payload.code);
                    // Already reaped: forget it so its PID is never signaled.
                    let state = events_app.state::<Server>();
                    let mut owned = state.child.lock().unwrap();
                    if owned.as_ref().is_some_and(|child| child.pid() == pid) {
                        *owned = None;
                        *state.private.lock().unwrap() = None;
                    }
                    drop(owned);
                    let _ = exited_tx.send(());
                    break;
                }
                _ => {}
            }
        }
    });
    let server = discovery::RunningServer {
        pid,
        address: format!("127.0.0.1:{port}").parse().unwrap(),
        profile: Some("desktop".into()),
        token,
    };
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if exited_rx.try_recv().is_ok() {
                return Err("The bundled server exited. Another btmux app or server may be using the desktop profile.".into());
            }
            if servers::ready(&server) {
                *state.private.lock().unwrap() = Some(server.clone());
                return open_server(&window, &server);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Could not start btmux. Check the desktop app logs.".into())
    })();
    if result.is_err()
        && let Some(child) = state.child.lock().unwrap().take()
    {
        *state.private.lock().unwrap() = None;
        stop_server(child);
    }
    result
}

#[tauri::command]
async fn start_server(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_private_server(app, window))
        .await
        .map_err(|_| "Could not start btmux.".to_string())?
}

#[cfg(target_os = "macos")]
fn login_shell() -> Option<String> {
    let user = unsafe { libc::getpwuid(libc::getuid()) };
    if user.is_null() || unsafe { (*user).pw_shell.is_null() } {
        return None;
    }
    let shell = unsafe { CStr::from_ptr((*user).pw_shell) };
    let shell = shell.to_str().ok()?;
    (!shell.is_empty()).then(|| shell.to_owned())
}

#[cfg(target_os = "macos")]
fn login_path(shell: &str) -> Option<String> {
    let output = std::process::Command::new(shell)
        .args(["-l", "-i", "-c", "exec /usr/bin/printenv PATH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout
        .lines()
        .last()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

// Shows an OS notification; a click focuses the window and runs the page's onclick.
#[tauri::command]
fn notify(window: WebviewWindow, id: String, title: String, body: String) {
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        &window.config().identifier
    });
    std::thread::spawn(move || {
        let mut clicked = false;
        match notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .action("default", "Show")
            .show()
        {
            Ok(handle) => handle.wait_for_action(|action| clicked = action == "default"),
            Err(error) => eprintln!("btmux notification failed: {error}"),
        }
        if clicked {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        let id = serde_json::to_string(&id).unwrap();
        let _ = window.eval(format!("window.__btmuxNotificationDone?.({id}, {clicked})"));
    });
}

// The desktop app's own version, which may differ from the connected server's.
#[tauri::command]
fn desktop_info() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn unused_loopback_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub fn run() {
    // WKWebView otherwise shows the accent popup instead of repeating held keys.
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSUserDefaults, ns_string};
        NSUserDefaults::standardUserDefaults()
            .setBool_forKey(false, ns_string!("ApplePressAndHoldEnabled"));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Server::default())
        .invoke_handler(tauri::generate_handler![
            discover_servers,
            connect_server,
            start_server,
            notify,
            desktop_info
        ])
        .on_menu_event(|app, event| {
            if event.id() == SWITCH_SERVER
                && let Some(window) = app.get_webview_window("main")
            {
                show_picker(&window, "switch");
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                let file = menu.items()?.into_iter().find_map(|item| match item {
                    MenuItemKind::Submenu(menu) if menu.text().is_ok_and(|text| text == "File") => {
                        Some(menu)
                    }
                    _ => None,
                });
                if let Some(file) = file {
                    let switch = MenuItem::with_id(
                        app,
                        SWITCH_SERVER,
                        "Switch Server…",
                        true,
                        Some("CmdOrCtrl+Shift+O"),
                    )?;
                    file.insert(&switch, 0)?;
                    file.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                }
                app.set_menu(menu)?;
            }
            let window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(640.0, 400.0)
                    .initialization_script(include_str!("notification.js"));
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .transparent(true)
                .title_bar_style(TitleBarStyle::Visible)
                .initialization_script("window.__btmuxDesktopTransparency = true;");
            let window = window_builder.build()?;
            let _ = app.state::<Server>().picker.set(window.url()?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building btmux desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(server) = app.try_state::<Server>()
                && let Some(child) = server.child.lock().unwrap().take()
            {
                stop_server(child);
            }
        });
}
