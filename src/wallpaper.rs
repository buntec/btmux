//! Serves wallpaper images from `/wallpaper?source=`: a local file, or a
//! remote image the server fetches, so WebGPU can sample it without CORS.

use std::path::PathBuf;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::sync::Mutex;

use crate::config::VERSION;

/// Largest remote image the server fetches.
const MAX_REMOTE_BYTES: usize = 32 * 1024 * 1024;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(15);
/// An SVG opened directly as a document must not run script on this origin.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

#[derive(Clone, Debug, PartialEq)]
enum Source {
    File(PathBuf),
    Remote(String),
}

/// What `/wallpaper` serves for a configured value, if anything.
fn source(raw: &str) -> Option<Source> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        Some(Source::Remote(raw.to_string()))
    } else if raw.starts_with('/') {
        Some(Source::File(PathBuf::from(raw)))
    } else {
        raw.strip_prefix('~').map(|rest| {
            Source::File(match std::env::var("HOME") {
                Ok(home) => PathBuf::from(home).join(rest.strip_prefix('/').unwrap_or(rest)),
                Err(_) => PathBuf::from(raw),
            })
        })
    }
}

/// The URL browsers load for a configured wallpaper. Other values (e.g.
/// `data:` URLs) load directly.
pub fn url(raw: &str) -> String {
    if source(raw).is_none() {
        return raw.to_string();
    }
    let encoded: String = raw
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect();
    format!("/wallpaper?source={encoded}")
}

#[derive(Clone, Debug)]
struct Image {
    content_type: String,
    data: Bytes,
}

/// The last remote image, so tabs and reloads don't refetch it.
static REMOTE: Mutex<Option<(String, Image)>> = Mutex::const_new(None);

pub async fn serve(raw: &str) -> Response {
    let image = match source(raw) {
        None => return StatusCode::NOT_FOUND.into_response(),
        // Only images, though `/api/file` serves any file.
        Some(Source::File(path)) if check_file(&path).await.is_err() => {
            return StatusCode::NOT_FOUND.into_response()
        }
        Some(Source::File(path)) => match tokio::fs::read(&path).await {
            Ok(data) => Image {
                content_type: mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string(),
                data: data.into(),
            },
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        },
        Some(Source::Remote(url)) => match remote(&url).await {
            Ok(image) => image,
            Err(error) => {
                tracing::warn!("could not fetch wallpaper: {error}");
                return (StatusCode::BAD_GATEWAY, error).into_response();
            }
        },
    };
    (
        [
            (header::CONTENT_TYPE, image.content_type),
            (header::CACHE_CONTROL, "no-cache".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                CONTENT_SECURITY_POLICY.to_string(),
            ),
        ],
        Body::from(image.data),
    )
        .into_response()
}

/// For `/api/wallpaper/check`: why a value can't be a wallpaper, if it can't.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WallpaperCheck {
    pub error: Option<String>,
    /// What browsers load for a valid value, e.g. to preview it.
    pub url: Option<String>,
}

pub async fn check(raw: &str) -> WallpaperCheck {
    let error = match source(raw) {
        None if raw.starts_with("data:image/") => None,
        None => Some("Use an http(s) URL, an absolute or ~/ path, or a data:image URL".into()),
        Some(Source::File(path)) => check_file(&path).await.err(),
        // Fetch outside the cache lock, so a slow check doesn't hold up `serve`.
        Some(Source::Remote(url)) => match cached(&url).await {
            Some(_) => None,
            None => match fetch(&url).await {
                Ok(image) => {
                    // Applying the checked URL then serves it at once.
                    *REMOTE.lock().await = Some((url, image));
                    None
                }
                Err(error) => Some(error),
            },
        },
    };
    WallpaperCheck {
        url: error.is_none().then(|| url(raw)),
        error,
    }
}

async fn check_file(path: &std::path::Path) -> Result<(), String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "File not found".to_string(),
            std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
            _ => e.to_string(),
        })?;
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Not a file".into());
    }
    if mime_guess::from_path(path).first_or_octet_stream().type_() != mime_guess::mime::IMAGE {
        return Err("Not an image file".into());
    }
    Ok(())
}

async fn cached(url: &str) -> Option<Image> {
    match REMOTE.lock().await.as_ref() {
        Some((cached, image)) if cached == url => Some(image.clone()),
        _ => None,
    }
}

async fn remote(url: &str) -> Result<Image, String> {
    // Held while fetching, so concurrent tabs share one request.
    let mut cache = REMOTE.lock().await;
    if let Some((cached, image)) = cache.as_ref() {
        if cached == url {
            return Ok(image.clone());
        }
    }
    let image = fetch(url).await?;
    *cache = Some((url.to_string(), image.clone()));
    Ok(image)
}

async fn fetch(url: &str) -> Result<Image, String> {
    let client = reqwest::Client::builder()
        .timeout(REMOTE_TIMEOUT)
        .user_agent(format!("btmux/{VERSION}"))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("wallpaper request failed: {}", e.without_url()))?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if !content_type.starts_with("image/") {
        return Err(format!("wallpaper is not an image ({content_type:?})"));
    }
    let too_large = || format!("wallpaper exceeds {} MiB", MAX_REMOTE_BYTES >> 20);
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("could not read wallpaper: {}", e.without_url()))?
    {
        if data.len() + chunk.len() > MAX_REMOTE_BYTES {
            return Err(too_large());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(Image {
        content_type,
        data: data.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_served_and_direct_wallpapers() {
        assert_eq!(
            url("https://example.com/a b.png?x=1&y"),
            "/wallpaper?source=https%3A%2F%2Fexample.com%2Fa%20b.png%3Fx%3D1%26y"
        );
        assert_eq!(
            source("https://example.com/a.png"),
            Some(Source::Remote("https://example.com/a.png".into()))
        );
        assert_eq!(url("/srv/bg.jpg"), "/wallpaper?source=%2Fsrv%2Fbg.jpg");
        assert_eq!(
            source("/srv/bg.jpg"),
            Some(Source::File("/srv/bg.jpg".into()))
        );

        let data = "data:image/png;base64,AAAA";
        assert_eq!(url(data), data);
        assert_eq!(source(data), None);
    }

    /// Serves one response from a local listener and returns its URL.
    async fn upstream(response: &'static [u8]) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
        });
        format!("http://{address}/image")
    }

    #[tokio::test]
    async fn fetches_only_bounded_images() {
        let png = upstream(
            b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4\r\n\r\nPNG!",
        )
        .await;
        let image = fetch(&png).await.unwrap();
        assert_eq!(image.content_type, "image/png");
        assert_eq!(&image.data[..], b"PNG!");

        let html =
            upstream(b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\n\r\nhi")
                .await;
        assert!(fetch(&html).await.unwrap_err().contains("not an image"));

        let huge = upstream(
            b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 999999999\r\n\r\n",
        )
        .await;
        assert!(fetch(&huge).await.unwrap_err().contains("exceeds"));

        let missing = upstream(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await;
        assert!(fetch(&missing).await.is_err());
    }

    #[tokio::test]
    async fn checks_sources() {
        let dir = std::env::temp_dir().join(format!("btmux-wallpaper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let image = dir.join("bg.png");
        let text = dir.join("notes.txt");
        std::fs::write(&image, b"PNG!").unwrap();
        std::fs::write(&text, b"hi").unwrap();
        let error = |raw: String| async move { check(&raw).await.error };
        let checked = check(&image.display().to_string()).await;
        assert_eq!(checked.error, None);
        assert_eq!(checked.url, Some(url(&image.display().to_string())));
        assert_eq!(
            error(dir.join("missing.png").display().to_string()).await,
            Some("File not found".into())
        );
        assert_eq!(
            error(text.display().to_string()).await,
            Some("Not an image file".into())
        );
        assert_eq!(check(&text.display().to_string()).await.url, None);
        let served = serve(&text.display().to_string()).await;
        assert_eq!(
            served.status(),
            StatusCode::NOT_FOUND,
            "only images are served"
        );
        assert_eq!(
            error(dir.display().to_string()).await,
            Some("Not a file".into())
        );
        assert_eq!(error("data:image/png;base64,AAAA".into()).await, None);
        assert!(error("bg.png".into()).await.is_some());
        std::fs::remove_dir_all(dir).unwrap();

        let png = upstream(
            b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4\r\n\r\nPNG!",
        )
        .await;
        assert_eq!(error(png.clone()).await, None);
        // The check fills the cache, so the URL serves without a second request.
        assert!(cached(&png).await.is_some());
    }

    #[tokio::test]
    async fn served_images_cannot_run_script() {
        let path =
            std::env::temp_dir().join(format!("btmux-wallpaper-{}.svg", uuid::Uuid::new_v4()));
        std::fs::write(&path, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        let response = serve(&path.display().to_string()).await;
        std::fs::remove_file(path).unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "image/svg+xml");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox"));
        assert_eq!(serve("bg.svg").await.status(), StatusCode::NOT_FOUND);
    }
}
