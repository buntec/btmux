use std::collections::HashSet;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use std::ffi::CStr;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::ipc::CapabilityBuilder;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::webview::cookie::SameSite;
use tauri::webview::{Cookie, NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};

// Shared with the backend; only the launcher reads registrations.
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../src/discovery.rs"]
mod discovery;
mod remote;
mod servers;

const SWITCH_SERVER: &str = "switch-server";
const DESKTOP_PROFILE: &str = "desktop";

#[derive(Default)]
struct Server {
    child: Mutex<Option<CommandChild>>,
    // The bundled server, once ready. It does not publish a registration.
    private: Mutex<Option<discovery::RunningServer>>,
    choices: Mutex<Vec<discovery::RunningServer>>,
    // Bumped on every navigation so stale watchdogs stop.
    connection: AtomicU64,
    picker: OnceLock<Url>,
    // Serializes edits of the remote server file.
    remotes: Mutex<()>,
    // Remote origins granted the connected-page commands.
    remote_origins: Mutex<HashSet<String>>,
}

#[derive(serde::Serialize)]
struct ServerChoice {
    address: String,
    profile: String,
    url: String,
    bundled: bool,
    // A desktop-profile server the app may stop.
    desktop: bool,
    tailnet: Option<servers::Tailnet>,
}

#[tauri::command]
async fn discover_servers(state: State<'_, Server>) -> Result<Vec<ServerChoice>, String> {
    let private = state.private.lock().unwrap().clone();
    let bundled = private.as_ref().map(|server| server.address);
    let (servers, tailnet) = tauri::async_runtime::spawn_blocking(move || {
        let mut servers = servers::discover()?;
        servers.extend(private.filter(servers::ready));
        let tailnet = servers
            .iter()
            .find(|server| server.profile.as_deref() == Some(DESKTOP_PROFILE))
            .and_then(servers::tailnet);
        Ok::<_, String>((servers, tailnet))
    })
    .await
    .map_err(|_| "Could not look for running btmux servers.".to_string())??;
    let mut tailnet = tailnet;
    let choices = servers
        .iter()
        .map(|server| ServerChoice {
            address: server.address.to_string(),
            profile: server.profile.clone().unwrap_or_else(|| "default".into()),
            url: format!("http://{}/", server.address),
            bundled: Some(server.address) == bundled,
            desktop: server.profile.as_deref() == Some(DESKTOP_PROFILE),
            tailnet: if server.profile.as_deref() == Some(DESKTOP_PROFILE) {
                tailnet.take()
            } else {
                None
            },
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
fn watch(window: WebviewWindow, ready: impl Fn() -> bool + Send + 'static) {
    let generation = window.state::<Server>().connection.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut failures = 0;
        while failures < 3 {
            std::thread::sleep(Duration::from_secs(2));
            if window.state::<Server>().connection.load(Ordering::SeqCst) != generation {
                return;
            }
            failures = if ready() { 0 } else { failures + 1 };
        }
        show_picker(&window, "lost");
    });
}

fn open_server(window: &WebviewWindow, server: &discovery::RunningServer) -> Result<(), String> {
    // IPv6 needs the bare form: WKWebView ignores a "[::1]" domain.
    let cookie = Cookie::build((
        format!("btmux_auth_{}", server.address.port()),
        server.token.clone(),
    ))
    .domain(server.address.ip().to_string())
    .path("/")
    .http_only(true)
    .same_site(SameSite::Lax)
    .build();
    let url = format!("http://{}/", server.address).parse().unwrap();
    let server = server.clone();
    open_page(window, url, cookie, move || servers::ready(&server))
}

// Authenticates the webview with `cookie` and opens `url`.
fn open_page(
    window: &WebviewWindow,
    url: Url,
    cookie: Cookie<'static>,
    ready: impl Fn() -> bool + Send + 'static,
) -> Result<(), String> {
    let (name, token) = (cookie.name().to_string(), cookie.value().to_string());
    window
        .set_cookie(cookie)
        .map_err(|_| "Could not authenticate btmux.".to_string())?;
    let cookies = window
        .cookies()
        .map_err(|_| "Could not authenticate btmux.".to_string())?;
    if !cookies
        .iter()
        .any(|cookie| cookie.name() == name && cookie.value() == token)
    {
        return Err("Could not authenticate btmux.".into());
    }
    window
        .state::<Server>()
        .connection
        .fetch_add(1, Ordering::SeqCst);
    window
        .navigate(url)
        .map_err(|_| "Could not open btmux.".to_string())?;
    watch(window.clone(), ready);
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

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Could not find the app's settings folder.".to_string())
}

#[derive(serde::Serialize)]
struct RemoteChoice {
    url: String,
    profile: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn list_remote_servers(app: AppHandle) -> Result<Vec<RemoteChoice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let servers = remote::load(&config_dir(&app)?)?;
        // In parallel: an unreachable server takes the whole timeout.
        let probes: Vec<_> = servers
            .into_iter()
            .map(|server| {
                std::thread::spawn(move || {
                    let info = remote::probe(&server);
                    RemoteChoice {
                        url: server.url,
                        profile: info.as_ref().ok().and_then(|info| info.profile.clone()),
                        version: info.as_ref().ok().map(|info| info.version.clone()),
                        error: info.err(),
                    }
                })
            })
            .collect();
        Ok(probes
            .into_iter()
            .filter_map(|probe| probe.join().ok())
            .collect())
    })
    .await
    .map_err(|_| "Could not check remote servers.".to_string())?
}

// Saves a remote server once it accepts the token.
#[tauri::command]
async fn add_remote_server(app: AppHandle, url: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token.trim().to_string();
        if !discovery::valid_token(&token) {
            return Err("Enter the server's access token.".into());
        }
        let server = remote::RemoteServer {
            url: remote::origin(&url)?,
            token,
        };
        remote::probe(&server)?;
        let dir = config_dir(&app)?;
        let state = app.state::<Server>();
        let _lock = state.remotes.lock().unwrap();
        let mut servers = remote::load(&dir)?;
        servers.retain(|saved| saved.url != server.url);
        servers.push(server);
        remote::save(&dir, &servers)
    })
    .await
    .map_err(|_| "Could not add the server.".to_string())?
}

#[tauri::command]
async fn remove_remote_server(app: AppHandle, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        let state = app.state::<Server>();
        let _lock = state.remotes.lock().unwrap();
        let mut servers = remote::load(&dir)?;
        servers.retain(|saved| saved.url != url);
        remote::save(&dir, &servers)
    })
    .await
    .map_err(|_| "Could not remove the server.".to_string())?
}

#[tauri::command]
async fn connect_remote_server(
    app: AppHandle,
    window: WebviewWindow,
    url: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = remote::load(&config_dir(&app)?)?
            .into_iter()
            .find(|saved| saved.url == url)
            .ok_or("This server is no longer listed. Refresh the server list.")?;
        let info = remote::probe(&server)?;
        allow_remote(&app, &server.url)?;
        let cookie = Cookie::build((info.cookie, server.token.clone()))
            .domain(remote::cookie_domain(&server.url).unwrap_or_default())
            .path("/")
            .http_only(true)
            .secure(server.url.starts_with("https:"))
            .same_site(SameSite::Lax)
            .build();
        let page = format!("{}/", server.url).parse().unwrap();
        open_page(&window, page, cookie, move || {
            remote::probe(&server).is_ok()
        })
    })
    .await
    .map_err(|_| "Could not connect to btmux.".to_string())?
}

// Grants a remote origin what capabilities/notifications.json grants loopback.
fn allow_remote(app: &AppHandle, origin: &str) -> Result<(), String> {
    let state = app.state::<Server>();
    let mut allowed = state.remote_origins.lock().unwrap();
    if allowed.contains(origin) {
        return Ok(());
    }
    let capability = CapabilityBuilder::new(format!("remote-{}", allowed.len()))
        .remote(remote::url_pattern(origin).ok_or("Could not open btmux.")?)
        .local(false)
        .window("main")
        .permission("allow-notify")
        .permission("allow-desktop-info")
        .permission("allow-switch-server");
    app.add_capability(capability)
        .map_err(|_| "Could not open btmux.".to_string())?;
    allowed.insert(origin.to_string());
    Ok(())
}

fn terminate(child: CommandChild) {
    #[cfg(unix)]
    if unsafe { libc::kill(child.pid() as i32, libc::SIGTERM) } != 0 {
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    let _ = child.kill();
}

// The bundled server's command, with the desktop profile.
fn sidecar(app: &AppHandle, port: u16) -> Result<Command, String> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut sidecar = app
        .shell()
        .sidecar("btmux")
        .map_err(|_| "Could not find the bundled btmux server.".to_string())?;
    // Can take seconds: probe before taking locks.
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
    let sidecar = sidecar.args([
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--profile",
        DESKTOP_PROFILE,
        "--no-browser",
    ]);
    Ok(sidecar)
}

// Kept across starts: the tailnet URL includes it.
fn tailnet_port(app: &AppHandle) -> Result<u16, String> {
    let dir = config_dir(app)?;
    let path = dir.join("tailnet-port");
    if let Some(port) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
    {
        // Another port would change the tailnet URL.
        return match TcpListener::bind(("127.0.0.1", port)) {
            Ok(_) => Ok(port),
            Err(_) => Err(format!(
                "Port {port}, which the tailnet address uses, is in use. Free it, or delete {} to choose another port.",
                path.display()
            )),
        };
    }
    let port = unused_loopback_port().map_err(|_| "Could not choose a server port.".to_string())?;
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, format!("{port}\n")))
        .map_err(|_| "Could not save the tailnet server port.".to_string())?;
    Ok(port)
}

fn start_desktop_server(
    app: AppHandle,
    window: WebviewWindow,
    persistent: bool,
    tailscale: bool,
) -> Result<(), String> {
    if tailscale && !persistent {
        return Err("Only a server that keeps running can be shared on the tailnet.".into());
    }
    let state = app.state::<Server>();
    let running = state.private.lock().unwrap().clone();
    if let Some(server) = running
        && servers::ready(&server)
    {
        if persistent {
            return Err("The desktop server is running and stops when you quit. Stop it first to start one that keeps running.".into());
        }
        return open_server(&window, &server);
    }
    // A server that kept running owns the desktop profile.
    if let Some(server) = servers::discover()?
        .into_iter()
        .find(|server| server.profile.as_deref() == Some(DESKTOP_PROFILE))
    {
        return open_server(&window, &server);
    }
    let port = if tailscale {
        tailnet_port(&app)?
    } else {
        unused_loopback_port().map_err(|_| "Could not choose a server port.".to_string())?
    };
    let sidecar = sidecar(&app, port)?;
    if persistent {
        let sidecar = if tailscale {
            sidecar.arg("--tailscale")
        } else {
            sidecar
        };
        start_persistent_server(sidecar, &window)
    } else {
        start_private_server(&app, sidecar, port, &window)
    }
}

fn start_private_server(
    app: &AppHandle,
    sidecar: Command,
    port: u16,
    window: &WebviewWindow,
) -> Result<(), String> {
    let state = app.state::<Server>();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut owned = state.child.lock().unwrap();
    if owned.is_some() {
        return Err("The desktop server is already starting.".into());
    }
    let (mut events, child) = sidecar
        .args(["--desktop-parent-pid", &std::process::id().to_string()])
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
        profile: Some(DESKTOP_PROFILE.into()),
        token,
    };
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if exited_rx.try_recv().is_ok() {
                return Err(PROFILE_IN_USE.into());
            }
            if servers::ready(&server) {
                *state.private.lock().unwrap() = Some(server.clone());
                return open_server(window, &server);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Could not start btmux. Check the desktop app logs.".into())
    })();
    if result.is_err()
        && let Some(child) = state.child.lock().unwrap().take()
    {
        *state.private.lock().unwrap() = None;
        terminate(child);
    }
    result
}

const PROFILE_IN_USE: &str =
    "The bundled server exited. Another btmux app or server may be using the desktop profile.";

// Detached from the app: no parent watch, pipes, or shared session. It
// registers like a CLI server, so later launches discover it.
fn start_persistent_server(sidecar: Command, window: &WebviewWindow) -> Result<(), String> {
    let registration = discovery::state_dir()
        .ok_or("Could not find the btmux state directory.")?
        .join(DESKTOP_PROFILE)
        .join("state.server");
    let mut command = std::process::Command::from(sidecar);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the bundled btmux server.".to_string())?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(15);
    let server = loop {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err(PROFILE_IN_USE.into());
        }
        if let Some(server) = discovery::read_registration(&registration)
            && server.pid == pid
            && servers::ready(&server)
        {
            break server;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not start btmux. Check the btmux logs.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // Reap it if it stops while the app runs.
    std::thread::spawn(move || child.wait());
    open_server(window, &server)
}

#[tauri::command]
async fn start_server(
    app: AppHandle,
    window: WebviewWindow,
    persistent: bool,
    tailscale: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_desktop_server(app, window, persistent, tailscale)
    })
    .await
    .map_err(|_| "Could not start btmux.".to_string())?
}

#[tauri::command]
async fn stop_server(
    app: AppHandle,
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
    if server.profile.as_deref() != Some(DESKTOP_PROFILE) {
        return Err("Only desktop servers can be stopped here.".into());
    }
    let private = state
        .private
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|private| private.address == server.address);
    tauri::async_runtime::spawn_blocking(move || {
        let registration = discovery::state_dir()
            .map(|dir| dir.join(DESKTOP_PROFILE).join("state.server"))
            .ok_or("Could not find the btmux state directory.")?;
        // Lets it save state and stop editors; a signal on Windows can't.
        servers::shutdown(&server)?;
        let state = app.state::<Server>();
        // A private server stops once its exit handler forgets it, which keeps
        // it owned until then; a registered one once its registration is gone.
        let running = || {
            if private {
                owns_child(&state, server.pid)
            } else {
                discovery::read_registration(&registration).is_some_and(|r| r.pid == server.pid)
            }
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while running() {
            if Instant::now() >= deadline {
                return Err("The server did not stop.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    })
    .await
    .map_err(|_| "Could not stop btmux.".to_string())?
}

// Cleared by the exit handler once the private server stops.
fn owns_child(state: &Server, pid: u32) -> bool {
    let child = state.child.lock().unwrap();
    child.as_ref().is_some_and(|child| child.pid() == pid)
}

// Asks the private server to stop, and terminates it if it doesn't in time.
fn stop_private_server(state: &Server) {
    let private = state.private.lock().unwrap().clone();
    if let Some(server) = private
        && servers::shutdown(&server).is_ok()
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        while owns_child(state, server.pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    if let Some(child) = state.child.lock().unwrap().take() {
        terminate(child);
    }
}

// Lets connected btmux pages return to the picker on every platform.
#[tauri::command]
fn switch_server(window: WebviewWindow) {
    show_picker(&window, "switch");
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
            stop_server,
            switch_server,
            list_remote_servers,
            add_remote_server,
            remove_remote_server,
            connect_remote_server,
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
                    .initialization_script(include_str!("notification.js"))
                    // Links (window.open, target=_blank) open in the default browser.
                    .on_new_window(|url, _| {
                        if matches!(url.scheme(), "http" | "https") {
                            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        }
                        NewWindowResponse::Deny
                    });
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
            {
                stop_private_server(&server);
            }
        });
}
