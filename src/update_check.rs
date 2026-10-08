//! Opt-out reminder that a newer release exists. Never downloads or installs.

use std::time::Duration;

use serde::Deserialize;
use tokio::time::Instant;

use crate::config::VERSION;
use crate::ws::control::{ServerMessage, ToastLevel};
use crate::AppState;

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/buntec/btmux/releases/latest";
const RELEASES_URL: &str = "https://github.com/buntec/btmux/releases/latest";
const STARTUP_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How often to look for a viewer when a toast could not be delivered.
const TICK: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

fn parse_version(tag: &str) -> Option<Vec<u64>> {
    let core = tag.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    core.split('.').map(|part| part.parse().ok()).collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

async fn fetch_latest() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("btmux/{VERSION}"))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let release: Release = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(release.tag_name)
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut next_fetch = Instant::now() + STARTUP_DELAY;
        let mut latest: Option<String> = None;
        let mut notified: Option<String> = None;
        loop {
            tokio::time::sleep(TICK.min(next_fetch.saturating_duration_since(Instant::now())))
                .await;
            // Re-read every tick so config reloads take effect without a restart.
            if !state.read().await.check_for_updates() {
                continue;
            }
            if Instant::now() >= next_fetch {
                match fetch_latest().await {
                    Ok(tag) => {
                        tracing::debug!("latest release is {tag}");
                        latest = Some(tag);
                        next_fetch = Instant::now() + CHECK_INTERVAL;
                    }
                    Err(e) => {
                        tracing::debug!("update check failed: {e}");
                        next_fetch = Instant::now() + RETRY_INTERVAL;
                    }
                }
            }
            let Some(tag) = latest.as_deref() else {
                continue;
            };
            if notified.as_deref() == Some(tag) || !is_newer(tag, VERSION) {
                continue;
            }
            let message = ServerMessage::Toast {
                message: format!(
                    "btmux {} is available (running {VERSION}): {RELEASES_URL}",
                    tag.trim_start_matches('v')
                ),
                level: ToastLevel::Info,
            };
            let json = serde_json::to_string(&message).unwrap();
            // Fails only when no browser is connected; retry on a later tick.
            if state.read().await.events().send(json).is_ok() {
                notified = Some(tag.to_string());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numeric_components() {
        assert!(is_newer("v0.0.124", "0.0.123"));
        assert!(is_newer("0.1.0", "0.0.123"));
        assert!(is_newer("v0.0.1000", "0.0.999"));
        assert!(!is_newer("v0.0.123", "0.0.123"));
        assert!(!is_newer("v0.0.9", "0.0.123"));
    }

    #[test]
    fn ignores_unparseable_tags() {
        assert!(!is_newer("nightly", "0.0.123"));
        assert!(!is_newer("v1.x", "0.0.123"));
    }

    #[test]
    fn strips_prerelease_suffix() {
        assert_eq!(parse_version("v1.2.3-rc1"), Some(vec![1, 2, 3]));
    }
}
