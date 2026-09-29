use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::cookie::SameSite;
use tauri::webview::{Cookie, WebviewWindowBuilder};
use tauri::{Manager, RunEvent, WebviewUrl};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

struct Server(Mutex<Option<CommandChild>>);

fn unused_loopback_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn server_ready(port: u16, token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(200),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let request = format!(
        "GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut status = [0; 12];
    stream.read_exact(&mut status).is_ok() && &status == b"HTTP/1.1 200"
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = unused_loopback_port()?;
            let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let (mut events, child) = app
                .shell()
                .sidecar("btmux")?
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
                .spawn()?;

            app.manage(Server(Mutex::new(Some(child))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Terminated(payload) => {
                            eprintln!("btmux server exited: {:?}", payload.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("btmux")
                .inner_size(1200.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .build()?;

            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(15);
                while Instant::now() < deadline {
                    if server_ready(port, &token) {
                        let cookie_name = format!("btmux_auth_{port}");
                        let cookie = Cookie::build((cookie_name.clone(), token.clone()))
                            .domain("127.0.0.1")
                            .path("/")
                            .http_only(true)
                            .same_site(SameSite::Lax)
                            .build();
                        let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
                        let installed = window.set_cookie(cookie).and_then(|_| window.cookies());
                        match installed {
                            Ok(cookies)
                                if cookies
                                    .iter()
                                    .any(|cookie| cookie.name() == cookie_name && cookie.value() == token) =>
                            {
                                if let Err(error) = window.navigate(url) {
                                    eprintln!("could not open btmux: {error}");
                                    let _ = window.eval("document.body.textContent = 'Could not open btmux.'");
                                }
                            }
                            Ok(_) => {
                                eprintln!("btmux desktop cookie was not installed");
                                let _ = window.eval("document.body.textContent = 'Could not authenticate btmux.'");
                            }
                            Err(error) => {
                                eprintln!("could not set btmux desktop cookie: {error}");
                                let _ = window.eval("document.body.textContent = 'Could not authenticate btmux.'");
                            }
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = window.eval("document.body.textContent = 'Could not start btmux. Check the desktop app logs.'");
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building btmux desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(server) = app.try_state::<Server>()
                && let Some(child) = server.0.lock().unwrap().take()
            {
                #[cfg(unix)]
                {
                    if unsafe { libc::kill(child.pid() as i32, libc::SIGTERM) } == 0 {
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
                let _ = child.kill();
            }
        });
}
