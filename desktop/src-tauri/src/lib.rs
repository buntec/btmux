use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use std::ffi::CStr;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::webview::cookie::SameSite;
use tauri::webview::{Cookie, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// Shared with the backend; only the launcher reads registrations.
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../src/discovery.rs"]
mod discovery;
mod servers;

#[derive(Default)]
struct Server {
    child: Mutex<Option<CommandChild>>,
    choices: Mutex<Vec<discovery::RunningServer>>,
}

#[derive(serde::Serialize)]
struct ServerChoice {
    address: String,
    profile: String,
    url: String,
}

#[tauri::command]
async fn discover_servers(state: State<'_, Server>) -> Result<Vec<ServerChoice>, String> {
    let servers = tauri::async_runtime::spawn_blocking(servers::discover)
        .await
        .map_err(|_| "Could not look for running btmux servers.".to_string())??;
    let choices = servers
        .iter()
        .map(|server| ServerChoice {
            address: server.address.to_string(),
            profile: server.profile.clone().unwrap_or_else(|| "default".into()),
            url: format!("http://{}/", server.address),
        })
        .collect();
    *state.choices.lock().unwrap() = servers;
    Ok(choices)
}

fn open_server(window: &WebviewWindow, server: &discovery::RunningServer) -> Result<(), String> {
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
        .navigate(url)
        .map_err(|_| "Could not open btmux.".to_string())
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
    let port = unused_loopback_port().map_err(|_| "Could not choose a server port.".to_string())?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut owned = state.child.lock().unwrap();
    if owned.is_some() {
        return Err("A private desktop server is already starting.".into());
    }
    #[cfg(target_os = "macos")]
    let user_shell = login_shell();
    let mut sidecar = app
        .shell()
        .sidecar("btmux")
        .map_err(|_| "Could not find the bundled btmux server.".to_string())?;
    #[cfg(target_os = "macos")]
    if let Some(shell) = user_shell.as_deref() {
        // GUI launches miss PATH additions from interactive shell startup.
        if let Some(path) = login_path(shell) {
            sidecar = sidecar.env("PATH", path);
        }
        if std::env::var_os("SHELL").is_none() {
            sidecar = sidecar.env("SHELL", shell);
        }
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
    *owned = Some(child);
    drop(owned);
    let (exited_tx, exited_rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    eprintln!("btmux server exited: {:?}", payload.code);
                    let _ = exited_tx.send(());
                    break;
                }
                _ => {}
            }
        }
    });
    let server = discovery::RunningServer {
        pid: std::process::id(),
        address: format!("127.0.0.1:{port}").parse().unwrap(),
        profile: Some("desktop".into()),
        token,
    };
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if exited_rx.try_recv().is_ok() {
                return Err("The bundled server exited. The desktop profile may already be in use; refresh and connect to its server.".into());
            }
            if servers::ready(&server) {
                return open_server(&window, &server);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Could not start btmux. Check the desktop app logs.".into())
    })();
    if result.is_err()
        && let Some(child) = state.child.lock().unwrap().take()
    {
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

fn unused_loopback_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Server::default())
        .invoke_handler(tauri::generate_handler![
            discover_servers,
            connect_server,
            start_server
        ])
        .setup(|app| {
            let window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(640.0, 400.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .transparent(true)
                .title_bar_style(TitleBarStyle::Visible)
                .initialization_script("window.__btmuxDesktopTransparency = true;");
            window_builder.build()?;
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
