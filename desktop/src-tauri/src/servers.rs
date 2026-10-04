use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::Deserialize;

use crate::discovery::{self, RunningServer};

#[derive(Deserialize)]
struct ServerInfo {
    version: String,
    profile: Option<String>,
}

fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(500))
        .build()
}

fn probe(client: &Client, server: &RunningServer) -> Option<ServerInfo> {
    let response = client
        .get(format!("http://{}/api/info", server.address))
        .bearer_auth(&server.token)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .json::<ServerInfo>()
        .ok()
        .filter(|info| !info.version.is_empty())
}

pub fn ready(server: &RunningServer) -> bool {
    client()
        .ok()
        .and_then(|client| probe(&client, server))
        .is_some_and(|info| info.profile == server.profile)
}

fn discover_in(dir: &Path, client: &Client) -> Vec<RunningServer> {
    let mut servers = Vec::new();
    let mut addresses = HashSet::new();
    for path in discovery::registration_paths(dir) {
        if let Some(server) = discovery::read_registration(&path)
            && probe(client, &server).is_some_and(|info| info.profile == server.profile)
            && addresses.insert(server.address)
        {
            servers.push(server);
        }
    }

    // Older default-profile servers do not publish a registration.
    if !servers
        .iter()
        .any(|server| server.profile.is_none() && server.address.port() == 8004)
        && let Ok(token) = discovery::read_private_file(&dir.join("state.token"))
    {
        let token = token.trim().to_string();
        if discovery::valid_token(&token) {
            for address in ["127.0.0.1:8004", "[::1]:8004"] {
                let server = RunningServer {
                    pid: 0,
                    address: address.parse().unwrap(),
                    profile: None,
                    token: token.clone(),
                };
                if !addresses.contains(&server.address)
                    && probe(client, &server).is_some_and(|info| info.profile.is_none())
                {
                    servers.push(server);
                    break;
                }
            }
        }
    }
    servers.sort_by(|a, b| a.profile.cmp(&b.profile).then(a.address.cmp(&b.address)));
    servers
}

pub fn discover() -> Result<Vec<RunningServer>, String> {
    let Some(dir) = discovery::state_dir() else {
        return Ok(Vec::new());
    };
    let client = client().map_err(|_| "Could not check local btmux servers.".to_string())?;
    Ok(discover_in(&dir, &client))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn rejects_auth_failures_redirects_and_non_btmux_responses() {
        for (status, body) in [
            ("401 Unauthorized", r#"{"version":"test","profile":null}"#),
            ("302 Found", r#"{"version":"test","profile":null}"#),
            ("200 OK", r#"{"unrelated":"service"}"#),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let server = RunningServer {
                pid: std::process::id(),
                address: listener.local_addr().unwrap(),
                profile: None,
                token: "t".repeat(64),
            };
            let responder = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                assert!(stream.read(&mut request).unwrap() > 0);
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            assert!(!ready(&server));
            responder.join().unwrap();
        }
    }

    #[test]
    fn discovers_live_authenticated_servers_and_ignores_stale_records() {
        let dir = std::env::temp_dir().join(format!("btmux-launcher-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("stale")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let token = "t".repeat(64);
        let registration =
            discovery::Registration::publish(&dir.join("state.json"), address, None, token.clone())
                .unwrap();
        let stale_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let stale_address = stale_listener.local_addr().unwrap();
        drop(stale_listener);
        let stale = discovery::Registration::publish(
            &dir.join("stale/state.json"),
            stale_address,
            Some("stale".into()),
            token.clone(),
        )
        .unwrap();
        let responder = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.contains(&format!("authorization: bearer {token}")));
                let body = r#"{"version":"test","profile":null}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let client = client().unwrap();
        let servers = discover_in(&dir, &client);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].address, address);
        let mut mismatched = servers[0].clone();
        mismatched.profile = Some("wrong-profile".into());
        assert!(!ready(&mismatched));
        responder.join().unwrap();
        drop(registration);
        drop(stale);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
