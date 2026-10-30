//! `--tailscale`: serve over HTTPS on the tailnet through `tailscale serve`,
//! which terminates TLS and preserves the Host header.
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde::Deserialize;
use tokio::process::Command;

use crate::auth::Auth;

#[cfg(target_os = "macos")]
const PROGRAMS: &[&str] = &[
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
#[cfg(not(target_os = "macos"))]
const PROGRAMS: &[&str] = &["tailscale"];

const TIMEOUT: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_secs(10);

/// The HTTPS port `tailscale serve` exposes, once it does.
static SERVED: OnceLock<u16> = OnceLock::new();

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

async fn run(args: &[&str]) -> Result<Vec<u8>, String> {
    for program in PROGRAMS {
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
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
        }
    }
    Err("the tailscale CLI is not installed".into())
}

/// The tailnet HTTPS URL for `port`, from `tailscale status --json`.
fn url(status: &[u8], port: u16) -> Result<String, String> {
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
    Ok(if port == 443 {
        format!("https://{name}")
    } else {
        format!("https://{name}:{port}")
    })
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

async fn serve(address: SocketAddr, auth: &Auth) -> Result<String, String> {
    let port = address.port();
    let url = url(&run(&["status", "--json"]).await?, port)?;
    auth.allow(&url)?;
    run(&[
        "serve",
        "--bg",
        "--yes",
        &format!("--https={port}"),
        &format!("http://{}", target(address)),
    ])
    .await?;
    let _ = SERVED.set(port);
    Ok(url)
}

/// Expose the server on its port of the tailnet HTTPS name, retrying until
/// Tailscale is up.
pub fn spawn(address: SocketAddr, auth: Arc<Auth>) {
    tokio::spawn(async move {
        let mut last_error = String::new();
        loop {
            match serve(address, &auth).await {
                Ok(url) => {
                    eprintln!("btmux tailnet URL: {url}");
                    tracing::info!("tailnet URL: {url}");
                    return;
                }
                Err(error) if error != last_error => {
                    eprintln!("btmux: tailscale serve: {error} (retrying)");
                    tracing::warn!("tailscale serve: {error} (retrying)");
                    last_error = error;
                }
                Err(_) => {}
            }
            tokio::time::sleep(RETRY).await;
        }
    });
}

/// Remove the serve config on shutdown (not on upgrade, which keeps it).
pub async fn shutdown() {
    if let Some(port) = SERVED.get() {
        if let Err(error) = run(&["serve", &format!("--https={port}"), "off"]).await {
            tracing::warn!("tailscale serve off: {error}");
        }
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
            url(&running, 8004).unwrap(),
            "https://box.tail1.ts.net:8004"
        );
        assert_eq!(url(&running, 443).unwrap(), "https://box.tail1.ts.net");
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
}
