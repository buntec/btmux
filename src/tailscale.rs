//! `--tailscale`: serve over HTTPS on the tailnet through `tailscale serve`,
//! which terminates TLS and preserves the Host header.
//!
//! The Serve config is machine-wide, so btmux never replaces another route on
//! its port, and removes only a route it created. A marker file beside the
//! profile's state records that route, so an upgrade or a restart after a
//! crash takes it over.
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    process::Command,
    sync::{broadcast, Mutex},
};

use crate::auth::Auth;
use crate::ws::control::ServerMessage;

#[cfg(target_os = "macos")]
const PROGRAMS: &[&str] = &[
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
#[cfg(not(target_os = "macos"))]
const PROGRAMS: &[&str] = &["tailscale"];

// Shutdown waits for a command in flight, up to this long.
const TIMEOUT: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_secs(10);
// While serving, how often to check that the route still works.
const CHECK: Duration = Duration::from_secs(30);

static INSTANCE: OnceLock<Arc<Tailscale>> = OnceLock::new();

/// Whether `--tailscale` serves the tailnet URL yet.
#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum TailscaleStatus {
    Starting,
    Serving {
        url: String,
    },
    /// The last attempt failed; btmux keeps retrying.
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Status {
    backend_state: String,
    #[serde(rename = "Self")]
    node: Option<Node>,
    cert_domains: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

/// `tailscale serve status --json`, as far as btmux reads it.
#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ServeConfig {
    #[serde(rename = "TCP", default)]
    tcp: HashMap<String, TcpHandler>,
    #[serde(default)]
    web: HashMap<String, WebConfig>,
    // Routes of `tailscale serve` commands running in the foreground.
    #[serde(default)]
    foreground: HashMap<String, ServeConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TcpHandler {
    #[serde(rename = "HTTP", default)]
    http: bool,
    #[serde(rename = "TCPForward")]
    tcp_forward: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WebConfig {
    #[serde(default)]
    handlers: HashMap<String, Handler>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Handler {
    proxy: Option<String>,
    path: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Route {
    Free,
    /// Already proxies to btmux.
    Same,
    /// Serves something else, described.
    Taken(String),
}

/// What the HTTPS root of `host:port` serves, compared with `proxy`.
fn route(config: &ServeConfig, host: &str, port: u16, proxy: &str) -> Route {
    let background = std::iter::once((config, false));
    let foreground = config.foreground.values().map(|config| (config, true));
    for (config, foreground) in background.chain(foreground) {
        if let Some(tcp) = config.tcp.get(&port.to_string()) {
            if let Some(target) = &tcp.tcp_forward {
                return Route::Taken(format!("a TCP forward to {target}"));
            }
            if tcp.http {
                return Route::Taken("plain HTTP".into());
            }
        }
        let web = config
            .web
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(&format!("{host}:{port}")));
        let Some(root) = web.and_then(|(_, web)| web.handlers.get("/")) else {
            continue;
        };
        return match (&root.proxy, &root.path) {
            // A foreground route ends with its command.
            (Some(target), _) if target == proxy && !foreground => Route::Same,
            (Some(target), _) => Route::Taken(format!("a proxy to {target}")),
            (None, Some(path)) => Route::Taken(format!("files from {path}")),
            (None, None) => Route::Taken("text".into()),
        };
    }
    Route::Free
}

/// The tailnet name and HTTPS URL for `port`, from `tailscale status --json`.
fn url(status: &[u8], port: u16) -> Result<(String, String), String> {
    let status: Status = serde_json::from_slice(status).map_err(|e| e.to_string())?;
    if status.backend_state != "Running" {
        return Err(format!("Tailscale is {}", status.backend_state));
    }
    let name = status
        .node
        .map(|node| node.dns_name.trim_end_matches('.').to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .ok_or("this machine has no tailnet DNS name; enable MagicDNS")?;
    if !status
        .cert_domains
        .unwrap_or_default()
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case(&name))
    {
        return Err("enable HTTPS certificates for the tailnet: https://tailscale.com/kb/1153/enabling-https".into());
    }
    let url = if port == 443 {
        format!("https://{name}")
    } else {
        format!("https://{name}:{port}")
    };
    Ok((name, url))
}

/// Where `tailscale serve` reaches a server listening on `address`.
fn target(address: SocketAddr) -> SocketAddr {
    let ip = match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    SocketAddr::new(ip, address.port())
}

#[derive(Default)]
struct State {
    stopped: bool,
    // This process may have created the route.
    owned: bool,
    host: Option<String>,
}

struct Tailscale {
    programs: Vec<PathBuf>,
    port: u16,
    proxy: String,
    /// Records the route btmux created: `<port> <proxy>`.
    marker: Option<PathBuf>,
    // Held across each setup attempt, so shutdown waits for one in flight.
    state: Mutex<State>,
    status: std::sync::Mutex<TailscaleStatus>,
}

impl Tailscale {
    fn new(programs: Vec<PathBuf>, address: SocketAddr, marker: Option<PathBuf>) -> Self {
        Self {
            programs,
            port: address.port(),
            proxy: format!("http://{}", target(address)),
            marker,
            state: Mutex::default(),
            status: std::sync::Mutex::new(TailscaleStatus::Starting),
        }
    }

    /// Record `status`, and broadcast it if it changed. Returns whether it did.
    fn report(&self, status: TailscaleStatus, events: &broadcast::Sender<String>) -> bool {
        let mut current = self.status.lock().unwrap();
        if *current == status {
            return false;
        }
        *current = status.clone();
        let _ = events.send(serde_json::to_string(&ServerMessage::Tailscale { status }).unwrap());
        true
    }

    async fn cli(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        for program in &self.programs {
            let mut command = Command::new(program);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            match tokio::time::timeout(TIMEOUT, command.output()).await {
                Err(_) => return Err(format!("`tailscale {}` timed out", args.join(" "))),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(output)) if output.status.success() => return Ok(output.stdout),
                Ok(Ok(output)) => {
                    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if error.is_empty() {
                        return Err(format!("`tailscale {}` failed", args.join(" ")));
                    }
                    return Err(error);
                }
            }
        }
        Err("the tailscale CLI is not installed".into())
    }

    async fn serve_config(&self) -> Result<ServeConfig, String> {
        let output = self.cli(&["serve", "status", "--json"]).await?;
        if output.trim_ascii().is_empty() {
            return Ok(ServeConfig::default());
        }
        serde_json::from_slice(&output).map_err(|e| format!("unexpected serve status: {e}"))
    }

    async fn host(&self) -> Result<String, String> {
        Ok(url(&self.cli(&["status", "--json"]).await?, self.port)?.0)
    }

    async fn off(&self, port: u16) -> Result<(), String> {
        self.cli(&["serve", &format!("--https={port}"), "off"])
            .await
            .map(drop)
    }

    fn marked(&self) -> Option<(u16, String)> {
        let text = std::fs::read_to_string(self.marker.as_ref()?).ok()?;
        let (port, proxy) = text.trim().split_once(' ')?;
        Some((port.parse().ok()?, proxy.to_string()))
    }

    fn mark(&self) {
        let Some(marker) = &self.marker else { return };
        if let Err(error) = std::fs::write(marker, format!("{} {}\n", self.port, self.proxy)) {
            tracing::warn!("could not record the tailscale serve route: {error}");
        }
    }

    fn unmark(&self) {
        if let Some(marker) = &self.marker {
            let _ = std::fs::remove_file(marker);
        }
    }

    /// Serve btmux unless the route is taken. Returns its URL, or None once stopped.
    async fn attempt(&self, auth: &Auth) -> Result<Option<String>, String> {
        let mut state = self.state.lock().await;
        if state.stopped {
            return Ok(None);
        }
        let (host, url) = url(&self.cli(&["status", "--json"]).await?, self.port)?;
        state.host = Some(host.clone());
        auth.allow(&url)?;
        let config = self.serve_config().await?;
        let marked = self.marked();
        match route(&config, &host, self.port, &self.proxy) {
            Route::Taken(what) => Err(format!(
                "{host}:{} already serves {what}; remove that route or serve btmux on another port",
                self.port
            )),
            Route::Same => {
                // Created by this process, an earlier btmux on this profile,
                // or the user.
                state.owned |= marked == Some((self.port, self.proxy.clone()));
                Ok(Some(url))
            }
            Route::Free => {
                // A route left on another port by an earlier btmux.
                if let Some((port, proxy)) = marked {
                    if route(&config, &host, port, &proxy) == Route::Same {
                        self.off(port).await?;
                    }
                }
                // Before the command: the daemon may keep the route even if it fails.
                state.owned = true;
                self.mark();
                self.cli(&[
                    "serve",
                    "--bg",
                    "--yes",
                    &format!("--https={}", self.port),
                    &self.proxy,
                ])
                .await?;
                Ok(Some(url))
            }
        }
    }

    /// Stop setting up, and remove the route if btmux created it.
    async fn stop(&self) {
        let mut state = self.state.lock().await;
        state.stopped = true;
        if !state.owned && self.marked() != Some((self.port, self.proxy.clone())) {
            return;
        }
        let host = match state.host.clone() {
            Some(host) => host,
            None => match self.host().await {
                Ok(host) => host,
                Err(error) => {
                    // Keep the marker; the next start cleans up.
                    tracing::warn!("tailscale serve cleanup: {error}");
                    return;
                }
            },
        };
        let result = match self.serve_config().await {
            Ok(config) if route(&config, &host, self.port, &self.proxy) == Route::Same => {
                self.off(self.port).await
            }
            // Gone or changed since: not btmux's to remove.
            Ok(_) => Ok(()),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => self.unmark(),
            Err(error) => tracing::warn!("tailscale serve cleanup: {error}"),
        }
    }

    /// Set up the route, then keep checking it: Tailscale may stop, or the
    /// route be removed or replaced, while btmux runs.
    async fn run(
        &self,
        auth: &Auth,
        events: &broadcast::Sender<String>,
        check: Duration,
        retry: Duration,
    ) {
        let mut last_error = String::new();
        loop {
            let wait = match self.attempt(auth).await {
                Ok(Some(url)) => {
                    last_error.clear();
                    if self.report(TailscaleStatus::Serving { url: url.clone() }, events) {
                        eprintln!("btmux tailnet URL: {url}");
                        tracing::info!("tailnet URL: {url}");
                    }
                    check
                }
                Ok(None) => return,
                Err(error) => {
                    if error != last_error {
                        // Warnings reach the console by default.
                        tracing::warn!("tailscale serve: {error} (retrying)");
                        last_error = error.clone();
                    }
                    self.report(TailscaleStatus::Error { message: error }, events);
                    retry
                }
            };
            tokio::time::sleep(wait).await;
        }
    }
}

/// Expose the server on its port of the tailnet HTTPS name, retrying until
/// Tailscale is up and the route is free, and restoring the route if it goes.
pub fn spawn(
    address: SocketAddr,
    auth: Arc<Auth>,
    marker: Option<PathBuf>,
    events: broadcast::Sender<String>,
) {
    let programs = PROGRAMS.iter().map(PathBuf::from).collect();
    let tailscale = Arc::new(Tailscale::new(programs, address, marker));
    if INSTANCE.set(tailscale.clone()).is_err() {
        return;
    }
    tokio::spawn(async move { tailscale.run(&auth, &events, CHECK, RETRY).await });
}

/// The tailnet status, if the server runs with `--tailscale`.
pub fn status() -> Option<TailscaleStatus> {
    INSTANCE
        .get()
        .map(|tailscale| tailscale.status.lock().unwrap().clone())
}

/// Remove btmux's route on shutdown (not on upgrade, which keeps it).
pub async fn shutdown() {
    if let Some(tailscale) = INSTANCE.get() {
        tailscale.stop().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: &str, certs: &str) -> Vec<u8> {
        format!(
            r#"{{"BackendState":"{state}","Self":{{"DNSName":"Box.tail1.ts.net."}},"CertDomains":{certs}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn derives_the_tailnet_url() {
        let running = status("Running", r#"["box.tail1.ts.net"]"#);
        assert_eq!(
            url(&running, 8004).unwrap().1,
            "https://box.tail1.ts.net:8004"
        );
        assert_eq!(url(&running, 443).unwrap().1, "https://box.tail1.ts.net");
        assert_eq!(url(&running, 443).unwrap().0, "box.tail1.ts.net");
        assert!(url(&status("Stopped", r#"["box.tail1.ts.net"]"#), 8004).is_err());
        assert!(url(&status("Running", "null"), 8004)
            .unwrap_err()
            .contains("HTTPS"));
    }

    #[test]
    fn proxies_wildcard_listeners_through_loopback() {
        assert_eq!(
            target("0.0.0.0:8004".parse().unwrap()),
            "127.0.0.1:8004".parse().unwrap()
        );
        assert_eq!(
            target("[::]:8004".parse().unwrap()),
            "[::1]:8004".parse().unwrap()
        );
        assert_eq!(
            target("100.64.0.1:8004".parse().unwrap()),
            "100.64.0.1:8004".parse().unwrap()
        );
    }

    #[test]
    fn classifies_existing_routes() {
        let config = |json: &str| serde_json::from_str::<ServeConfig>(json).unwrap();
        let proxy = "http://127.0.0.1:8004";
        let check = |json: &str| route(&config(json), "box.tail1.ts.net", 8004, proxy);
        let web = |handler: &str| {
            format!(
                r#"{{"TCP":{{"8004":{{"HTTPS":true}}}},"Web":{{"box.tail1.ts.net:8004":{{"Handlers":{{"/":{handler}}}}}}}}}"#
            )
        };
        assert_eq!(check("{}"), Route::Free);
        assert_eq!(
            check(&web(r#"{"Proxy":"http://127.0.0.1:8004"}"#)),
            Route::Same
        );
        assert_eq!(
            check(&web(r#"{"Proxy":"http://127.0.0.1:3000"}"#)),
            Route::Taken("a proxy to http://127.0.0.1:3000".into())
        );
        assert_eq!(
            check(&web(r#"{"Path":"/srv"}"#)),
            Route::Taken("files from /srv".into())
        );
        assert_eq!(
            check(r#"{"TCP":{"8004":{"TCPForward":"127.0.0.1:22"}}}"#),
            Route::Taken("a TCP forward to 127.0.0.1:22".into())
        );
        // Other ports, and paths below the root, leave the root free.
        assert_eq!(
            check(
                r#"{"Web":{"box.tail1.ts.net:5173":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5173"}}}}}"#
            ),
            Route::Free
        );
        assert_eq!(
            check(
                r#"{"Web":{"box.tail1.ts.net:8004":{"Handlers":{"/api":{"Proxy":"http://127.0.0.1:9"}}}}}"#
            ),
            Route::Free
        );
        let foreground = format!(
            r#"{{"Foreground":{{"session":{}}}}}"#,
            web(r#"{"Proxy":"http://127.0.0.1:8004"}"#)
        );
        assert!(matches!(check(&foreground), Route::Taken(_)));
    }

    #[test]
    fn broadcasts_status_changes_only() {
        let tailscale = Tailscale::new(Vec::new(), "127.0.0.1:8004".parse().unwrap(), None);
        let (events, mut rx) = broadcast::channel(4);
        let error = || TailscaleStatus::Error {
            message: "down".into(),
        };
        assert!(!tailscale.report(TailscaleStatus::Starting, &events));
        assert!(tailscale.report(error(), &events));
        assert!(!tailscale.report(error(), &events));
        let message: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(
            message,
            serde_json::json!({"type": "tailscale", "status": {"state": "error", "message": "down"}})
        );
        assert!(rx.try_recv().is_err());
    }

    /// A fake `tailscale` CLI with a one-route Serve config in a file.
    #[cfg(unix)]
    mod fake {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;

        pub const STATUS: &str = r#"{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net."},"CertDomains":["box.tail1.ts.net"]}"#;

        pub fn route(port: u16, proxy: &str) -> String {
            format!(
                r#"{{"TCP":{{"{port}":{{"HTTPS":true}}}},"Web":{{"box.tail1.ts.net:{port}":{{"Handlers":{{"/":{{"Proxy":"{proxy}"}}}}}}}}}}"#
            )
        }

        pub struct Cli {
            pub dir: PathBuf,
        }

        impl Cli {
            pub fn new(config: &str) -> Self {
                let dir =
                    std::env::temp_dir().join(format!("btmux-tailscale-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("status.json"), STATUS).unwrap();
                std::fs::write(dir.join("serve.json"), config).unwrap();
                // `serve --bg` writes the route, then waits while `pause` exists,
                // as the daemon can keep a route before the command returns.
                let script = r#"#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$*" in
  "status --json") cat "$dir/status.json" ;;
  "serve status --json") cat "$dir/serve.json" ;;
  "serve --bg --yes --https="*)
    port=${4#--https=}
    printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"box.tail1.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$port" "$port" "$5" > "$dir/serve.json"
    while [ -e "$dir/pause" ]; do sleep 0.05; done ;;
  "serve --https="*" off") echo '{}' > "$dir/serve.json" ;;
  *) exit 1 ;;
esac
"#;
                let path = dir.join("tailscale");
                std::fs::write(&path, script).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
                Self { dir }
            }

            pub fn tailscale(&self, port: u16) -> Tailscale {
                Tailscale::new(
                    vec![self.dir.join("tailscale")],
                    SocketAddr::from(([127, 0, 0, 1], port)),
                    Some(self.dir.join("state.tailscale")),
                )
            }

            pub fn config(&self) -> String {
                std::fs::read_to_string(self.dir.join("serve.json"))
                    .unwrap()
                    .trim()
                    .to_string()
            }

            pub fn calls(&self) -> String {
                std::fs::read_to_string(self.dir.join("calls")).unwrap_or_default()
            }

            pub fn marker(&self) -> PathBuf {
                self.dir.join("state.tailscale")
            }

            pub fn path(&self, name: &str) -> PathBuf {
                Path::new(&self.dir).join(name)
            }
        }

        impl Drop for Cli {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
    }

    #[cfg(unix)]
    fn auth() -> Auth {
        Auth::new("a".repeat(64), "127.0.0.1", 8004, &[]).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn creates_and_removes_its_own_route() {
        let cli = fake::Cli::new("{}");
        let tailscale = cli.tailscale(8004);
        let url = tailscale.attempt(&auth()).await.unwrap();
        assert_eq!(url.as_deref(), Some("https://box.tail1.ts.net:8004"));
        assert_eq!(cli.config(), fake::route(8004, "http://127.0.0.1:8004"));
        assert!(cli.marker().exists());
        tailscale.stop().await;
        assert_eq!(cli.config(), "{}");
        assert!(!cli.marker().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_owning_its_route_without_a_marker() {
        let cli = fake::Cli::new("{}");
        let tailscale = Tailscale::new(
            vec![cli.path("tailscale")],
            SocketAddr::from(([127, 0, 0, 1], 8004)),
            None,
        );
        assert!(tailscale.attempt(&auth()).await.unwrap().is_some());
        // A periodic check finds the route it created.
        assert!(tailscale.attempt(&auth()).await.unwrap().is_some());
        tailscale.stop().await;
        assert_eq!(cli.config(), "{}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaves_other_routes_alone() {
        let other = fake::route(8004, "http://127.0.0.1:3000");
        let cli = fake::Cli::new(&other);
        let tailscale = cli.tailscale(8004);
        let error = tailscale.attempt(&auth()).await.unwrap_err();
        assert!(error.contains("http://127.0.0.1:3000"), "{error}");
        tailscale.stop().await;
        assert_eq!(cli.config(), other);
        assert!(!cli.calls().contains("--bg"));
        assert!(!cli.calls().contains("off"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uses_but_keeps_a_matching_route_it_did_not_create() {
        let same = fake::route(8004, "http://127.0.0.1:8004");
        let cli = fake::Cli::new(&same);
        let tailscale = cli.tailscale(8004);
        assert!(tailscale.attempt(&auth()).await.unwrap().is_some());
        tailscale.stop().await;
        assert_eq!(cli.config(), same);
        assert!(!cli.calls().contains("--bg"));
        assert!(!cli.calls().contains("off"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn takes_over_its_route_after_an_upgrade() {
        let cli = fake::Cli::new(&fake::route(8004, "http://127.0.0.1:8004"));
        std::fs::write(cli.marker(), "8004 http://127.0.0.1:8004\n").unwrap();
        let tailscale = cli.tailscale(8004);
        assert!(tailscale.attempt(&auth()).await.unwrap().is_some());
        assert!(!cli.calls().contains("--bg"));
        tailscale.stop().await;
        assert_eq!(cli.config(), "{}");
        assert!(!cli.marker().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removes_its_route_left_on_another_port() {
        let cli = fake::Cli::new(&fake::route(9000, "http://127.0.0.1:9000"));
        std::fs::write(cli.marker(), "9000 http://127.0.0.1:9000\n").unwrap();
        let tailscale = cli.tailscale(8004);
        assert!(tailscale.attempt(&auth()).await.unwrap().is_some());
        assert!(cli.calls().contains("serve --https=9000 off"));
        assert_eq!(cli.config(), fake::route(8004, "http://127.0.0.1:8004"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_and_restores_a_route_that_stops_working() {
        let cli = fake::Cli::new("{}");
        let tailscale = Arc::new(cli.tailscale(8004));
        let (events, mut rx) = broadcast::channel(16);
        let run = tokio::spawn({
            let tailscale = tailscale.clone();
            let ms = Duration::from_millis(20);
            async move { tailscale.run(&auth(), &events, ms, ms).await }
        });
        let mut next = async || {
            let message: serde_json::Value =
                serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
            message["status"]["state"].as_str().unwrap().to_string()
        };
        assert_eq!(next().await, "serving");
        std::fs::write(
            cli.path("status.json"),
            fake::STATUS.replace("Running", "Stopped"),
        )
        .unwrap();
        assert_eq!(next().await, "error");
        std::fs::write(cli.path("status.json"), fake::STATUS).unwrap();
        // Removed while Tailscale was down: created again.
        std::fs::write(cli.path("serve.json"), "{}").unwrap();
        assert_eq!(next().await, "serving");
        assert_eq!(cli.config(), fake::route(8004, "http://127.0.0.1:8004"));
        tailscale.stop().await;
        run.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_waits_for_setup_in_flight() {
        let cli = fake::Cli::new("{}");
        std::fs::write(cli.path("pause"), "").unwrap();
        let tailscale = Arc::new(cli.tailscale(8004));
        let setup = tokio::spawn({
            let tailscale = tailscale.clone();
            async move { tailscale.attempt(&auth()).await }
        });
        // The route exists while `serve --bg` is still running.
        while !cli.calls().contains("--bg") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let stop = tokio::spawn({
            let tailscale = tailscale.clone();
            async move { tailscale.stop().await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!stop.is_finished());
        std::fs::remove_file(cli.path("pause")).unwrap();
        stop.await.unwrap();
        assert!(setup.await.unwrap().unwrap().is_some());
        assert_eq!(cli.config(), "{}");
        // Stopped: no later attempt serves again.
        assert_eq!(tailscale.attempt(&auth()).await.unwrap(), None);
        assert_eq!(cli.config(), "{}");
    }
}
