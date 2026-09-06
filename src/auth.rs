//! One authentication boundary for HTTP, WebSocket upgrades, and MCP.
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::Engine;
use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

static TOKEN: OnceLock<String> = OnceLock::new();
pub fn shell_token() -> Option<&'static str> {
    TOKEN.get().map(String::as_str)
}

pub struct Auth {
    token: String,
    authorities: Vec<String>,
    origins: Vec<String>,
    cookie_name: String,
}

impl Auth {
    pub fn new(
        token: String,
        host: &str,
        port: u16,
        public_urls: &[String],
    ) -> Result<Self, String> {
        if token.len() < 32
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(
                "BTMUX_AUTH_TOKEN must contain at least 32 ASCII letters, digits, '-' or '_'"
                    .into(),
            );
        }
        let mut urls = public_urls.to_vec();
        let host = host.trim_matches(['[', ']']);
        urls.extend([
            format!("http://localhost:{port}"),
            format!("http://127.0.0.1:{port}"),
            format!("http://[::1]:{port}"),
        ]);
        if host != "localhost"
            && !host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        {
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host.to_string()
            };
            urls.push(format!("http://{host}:{port}"));
        }
        let mut origins = Vec::new();
        let mut authorities = Vec::new();
        for value in urls {
            let url = reqwest::Url::parse(&value).map_err(|e| e.to_string())?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(format!("invalid public URL {value:?}: supply an HTTP(S) origin without credentials or a path"));
            }
            let origin = url.origin().ascii_serialization();
            authorities.push(origin.split_once("://").unwrap().1.to_ascii_lowercase());
            origins.push(origin);
        }
        Ok(Self {
            token,
            authorities,
            origins,
            cookie_name: format!("btmux_auth_{port}"),
        })
    }

    fn permitted_request(&self, headers: &HeaderMap) -> bool {
        let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
            return false;
        };
        if !self
            .authorities
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
        {
            return false;
        }
        // Browser origins are checked even when valid credentials are supplied.
        // Non-browser automation may omit Origin but still needs a token.
        match headers.get(header::ORIGIN) {
            None => true,
            Some(origin) => origin
                .to_str()
                .is_ok_and(|o| self.origins.iter().any(|allowed| allowed == o)),
        }
    }

    fn authenticated(&self, headers: &HeaderMap) -> bool {
        if let Some(value) = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
        {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return constant_time_eq(token.as_bytes(), self.token.as_bytes());
            }
            // Browser-native password prompt: any username, token as password.
            if let Some(encoded) = value.strip_prefix("Basic ") {
                if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded) {
                    if let Some(index) = decoded.iter().position(|b| *b == b':') {
                        return constant_time_eq(&decoded[index + 1..], self.token.as_bytes());
                    }
                }
            }
            return false;
        }
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|h| h.to_str().ok())
            .flat_map(|h| h.split(';'))
            .any(|cookie| {
                cookie.trim().split_once('=').is_some_and(|(name, value)| {
                    name == self.cookie_name
                        && constant_time_eq(value.as_bytes(), self.token.as_bytes())
                })
            })
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

pub async fn protect(State(auth): State<Arc<Auth>>, request: Request, next: Next) -> Response {
    if !auth.permitted_request(request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !auth.authenticated(request.headers()) {
        let mut response = (StatusCode::UNAUTHORIZED, "Use your btmux access token as the password. The token file location is printed when the server starts.").into_response();
        if !request.uri().path().starts_with("/api/")
            && !request.uri().path().starts_with("/ws/")
            && !request.uri().path().starts_with("/mcp")
        {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                "Basic realm=\"btmux\", charset=\"UTF-8\"".parse().unwrap(),
            );
        }
        return response;
    }
    let set_cookie = request.headers().contains_key(header::AUTHORIZATION);
    let secure = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| auth.origins.iter().any(|o| o == &format!("https://{host}")));
    let mut response = next.run(request).await;
    if set_cookie {
        let cookie = format!(
            "{}={}; Path=/; HttpOnly; SameSite=Strict{}",
            auth.cookie_name,
            auth.token,
            if secure { "; Secure" } else { "" }
        );
        response
            .headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    }
    response
}

/// Persist a per-profile random credential with owner-only permissions. Never
/// print the credential or put it in URLs, browser history, or access logs.
pub fn load_token(state_path: Option<&Path>) -> Result<String, String> {
    use std::{
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    let token = if let Ok(token) = std::env::var("BTMUX_AUTH_TOKEN") {
        token
    } else {
        let path = state_path
            .ok_or("set BTMUX_AUTH_TOKEN when no state directory is available")?
            .with_extension("token");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                let token = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                file.write_all(token.as_bytes())
                    .map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "{} must be a regular owner-only file (chmod 600)",
                path.display()
            ));
        }
        eprintln!(
            "btmux access token: {} (browser username: btmux; password: file contents)",
            path.display()
        );
        std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())?
            .trim()
            .to_string()
    };
    let _ = TOKEN.set(token.clone());
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn auth() -> Auth {
        Auth::new("a".repeat(64), "127.0.0.1", 8004, &[]).unwrap()
    }
    #[test]
    fn rejects_cross_origin_and_rebound_hosts() {
        let auth = auth();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:8004".parse().unwrap());
        headers.insert(header::ORIGIN, "http://localhost:8004".parse().unwrap());
        assert!(auth.permitted_request(&headers));
        headers.insert(header::ORIGIN, "http://evil.example".parse().unwrap());
        assert!(!auth.permitted_request(&headers));
        headers.remove(header::ORIGIN);
        headers.insert(header::HOST, "evil.example:8004".parse().unwrap());
        assert!(!auth.permitted_request(&headers));
    }
    #[test]
    fn requires_credentials_for_every_transport() {
        let auth = auth();
        let mut headers = HeaderMap::new();
        assert!(!auth.authenticated(&headers));
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", "a".repeat(64)).parse().unwrap(),
        );
        assert!(auth.authenticated(&headers));
        headers.insert(
            header::AUTHORIZATION,
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("btmux:{}", "a".repeat(64)))
            )
            .parse()
            .unwrap(),
        );
        assert!(auth.authenticated(&headers));
        headers.remove(header::AUTHORIZATION);
        headers.insert(
            header::COOKIE,
            format!("btmux_auth_8004={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        assert!(auth.authenticated(&headers));
    }
}

#[cfg(test)]
mod middleware_tests {
    use super::*;
    use tower::ServiceExt;
    #[tokio::test]
    async fn protects_http_files_mcp_and_websocket_upgrades() {
        let auth = Arc::new(
            Auth::new(
                "a".repeat(64),
                "127.0.0.1",
                8004,
                &["https://terminal.example".into()],
            )
            .unwrap(),
        );
        let app = axum::Router::new()
            .fallback(|| async { "ok" })
            .layer(axum::middleware::from_fn_with_state(auth, protect));
        for path in [
            "/",
            "/api/sessions",
            "/api/file?path=/etc/passwd",
            "/ws/control",
            "/ws/files",
            "/ws/pane/id",
            "/mcp",
        ] {
            let request = Request::builder()
                .uri(path)
                .header(header::HOST, "localhost:8004")
                .body(axum::body::Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        let request = Request::builder()
            .uri("/api/sessions")
            .header(header::HOST, "terminal.example")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Strict")
                && cookie.contains("Secure")
        );
    }
}
