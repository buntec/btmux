//! Servers on other machines, added by URL and access token. Kept in an
//! owner-only file, since the token grants shell access.
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::{StatusCode, Url, header};
use serde::{Deserialize, Serialize};

use crate::discovery;

const FILE: &str = "remote-servers.json";

#[derive(Clone, Deserialize, Serialize)]
pub struct RemoteServer {
    /// An origin, e.g. `https://box.tail1.ts.net:8004`.
    pub url: String,
    pub token: String,
}

#[derive(Debug)]
pub struct Info {
    pub version: String,
    pub profile: Option<String>,
    /// The auth cookie's name, which names the server's port, not the URL's.
    pub cookie: String,
}

/// The origin for an entered address; HTTPS unless it names a scheme.
pub fn origin(input: &str) -> Result<String, String> {
    let input = input.trim();
    let input = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&input)
        .ok()
        .filter(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .ok_or("Enter a server address such as https://machine.tailnet.ts.net:8004.")?;
    Ok(url.origin().ascii_serialization())
}

pub fn load(dir: &Path) -> Result<Vec<RemoteServer>, String> {
    let path = dir.join(FILE);
    match discovery::read_private_file(&path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|_| format!("Could not read {}.", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(format!(
            "{} must be a regular file only you can read.",
            path.display()
        )),
    }
}

pub fn save(dir: &Path, servers: &[RemoteServer]) -> Result<(), String> {
    let path = dir.join(FILE);
    let temp = dir.join(format!("{FILE}.tmp"));
    let failed = |_| format!("Could not save {}.", path.display());
    std::fs::create_dir_all(dir).map_err(failed)?;
    let _ = std::fs::remove_file(&temp);
    let mut file = discovery::create_private_file(&temp).map_err(failed)?;
    file.write_all(&serde_json::to_vec_pretty(servers).unwrap())
        .and_then(|()| file.sync_all())
        .map_err(failed)?;
    drop(file);
    std::fs::rename(&temp, &path).map_err(failed)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Could not check remote servers.".to_string())
}

pub fn probe(server: &RemoteServer) -> Result<Info, String> {
    let not_btmux = || format!("{} is not a btmux server.", server.url);
    let response = client()?
        .get(format!("{}/api/info", server.url))
        .bearer_auth(&server.token)
        .send()
        .map_err(|_| format!("Could not reach {}.", server.url))?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err("The server rejected this token.".into()),
        StatusCode::FORBIDDEN => {
            return Err(format!(
                "The server refused this address. Start it with --tailscale or --public-url {}.",
                server.url
            ));
        }
        status => return Err(format!("{} returned HTTP {}.", server.url, status.as_u16())),
    }
    let cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(cookie_name)
        .ok_or_else(not_btmux)?;
    #[derive(Deserialize)]
    struct Body {
        version: String,
        profile: Option<String>,
    }
    let body: Body = response.json().map_err(|_| not_btmux())?;
    if body.version.is_empty() {
        return Err(not_btmux());
    }
    Ok(Info {
        version: body.version,
        profile: body.profile,
        cookie,
    })
}

fn cookie_name(set_cookie: &str) -> Option<String> {
    let (name, _) = set_cookie.split_once('=')?;
    name.starts_with("btmux_auth_").then(|| name.to_string())
}

/// A Tauri remote URL pattern for every page of `origin`.
pub fn url_pattern(origin: &str) -> Option<String> {
    let url = Url::parse(origin).ok()?;
    let mut host = String::new();
    for c in url.host_str()?.chars() {
        if "[]:".contains(c) {
            host.push('\\');
        }
        host.push(c);
    }
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{host}{port}/*", url.scheme()))
}

/// The cookie domain: WKWebView ignores a bracketed IPv6 domain.
pub fn cookie_domain(origin: &str) -> Option<String> {
    let url = Url::parse(origin).ok()?;
    Some(url.host_str()?.trim_matches(['[', ']']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn normalizes_entered_addresses() {
        assert_eq!(
            origin(" box.tail1.ts.net:8004 ").unwrap(),
            "https://box.tail1.ts.net:8004"
        );
        assert_eq!(
            origin("https://Box.tail1.ts.net/").unwrap(),
            "https://box.tail1.ts.net"
        );
        assert_eq!(
            origin("http://100.64.0.1:8004").unwrap(),
            "http://100.64.0.1:8004"
        );
        for invalid in [
            "",
            "ftp://box",
            "https://box/path",
            "https://user:pw@box",
            "https://box?x=1",
        ] {
            assert!(origin(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn matches_every_page_of_the_origin() {
        assert_eq!(
            url_pattern("https://box.tail1.ts.net:8004").unwrap(),
            "https://box.tail1.ts.net:8004/*"
        );
        assert_eq!(
            url_pattern("https://box.tail1.ts.net").unwrap(),
            "https://box.tail1.ts.net/*"
        );
        assert_eq!(
            url_pattern("http://[fd7a::1]:8004").unwrap(),
            r"http://\[fd7a\:\:1\]:8004/*"
        );
        let matches = |origin: &str, page: &str| {
            url_pattern(origin)
                .unwrap()
                .parse::<tauri::utils::acl::RemoteUrlPattern>()
                .unwrap()
                .test(&page.parse().unwrap())
        };
        let origin = "https://box.tail1.ts.net:8004";
        assert!(matches(origin, "https://box.tail1.ts.net:8004/"));
        assert!(matches(origin, "https://box.tail1.ts.net:8004/s/0/w/1?x=1"));
        assert!(!matches(origin, "https://box.tail1.ts.net:8005/"));
        assert!(!matches(origin, "http://box.tail1.ts.net:8004/"));
        assert!(!matches(
            origin,
            "https://evil.example/box.tail1.ts.net:8004/"
        ));
        assert!(matches(
            "https://box.tail1.ts.net",
            "https://box.tail1.ts.net/"
        ));
        assert!(matches(
            "http://[fd7a::1]:8004",
            "http://[fd7a::1]:8004/s/0"
        ));
        assert_eq!(cookie_domain("http://[fd7a::1]:8004").unwrap(), "fd7a::1");
        assert_eq!(
            cookie_domain("https://box.tail1.ts.net:8004").unwrap(),
            "box.tail1.ts.net"
        );
    }

    #[test]
    fn keeps_servers_in_an_owner_only_file() {
        let dir = std::env::temp_dir().join(format!("btmux-remotes-{}", uuid::Uuid::new_v4()));
        assert!(load(&dir).unwrap().is_empty());
        let servers = vec![RemoteServer {
            url: "https://box.tail1.ts.net:8004".into(),
            token: "t".repeat(64),
        }];
        save(&dir, &servers).unwrap();
        save(&dir, &servers).unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].token, servers[0].token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn respond(status: &str, headers: &str, body: &str) -> Result<Info, String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = RemoteServer {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: "t".repeat(64),
        };
        let (status, headers, body) = (status.to_string(), headers.to_string(), body.to_string());
        let responder = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /api/info "));
            assert!(request.contains(&format!("authorization: bearer {}", "t".repeat(64))));
            write!(stream, "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let result = probe(&server);
        responder.join().unwrap();
        result
    }

    #[test]
    fn probes_with_the_token_and_reads_the_cookie_name() {
        let info = respond(
            "200 OK",
            "Set-Cookie: btmux_auth_8004=x; Path=/; HttpOnly\r\nContent-Type: application/json\r\n",
            r#"{"version":"0.0.175","profile":"work"}"#,
        )
        .unwrap();
        assert_eq!(info.cookie, "btmux_auth_8004");
        assert_eq!(info.version, "0.0.175");
        assert_eq!(info.profile.as_deref(), Some("work"));
        assert!(
            respond("401 Unauthorized", "", "")
                .unwrap_err()
                .contains("token")
        );
        assert!(
            respond("403 Forbidden", "", "")
                .unwrap_err()
                .contains("--tailscale")
        );
        assert!(
            respond("200 OK", "", r#"{"version":"x"}"#)
                .unwrap_err()
                .contains("not a btmux server")
        );
        assert!(respond("302 Found", "Location: http://127.0.0.1:1/\r\n", "").is_err());
    }
}
