//! `btmux agents` and `btmux wait`: agent state for shell scripts.

use std::time::Duration;

use reqwest::Method;

use crate::api_client::request;

/// Prints the agent panes as JSON. Returns the exit code.
pub async fn agents(profile: Option<&str>) -> i32 {
    match get(profile, "/api/agents", Duration::from_secs(5)).await {
        Ok((_, body)) => {
            println!("{body}");
            0
        }
        Err(error) => fail(&error),
    }
}

/// Waits for an agent state and prints the outcome as JSON. Returns the exit
/// code: 0 when reached, 2 on timeout.
pub async fn wait(profile: Option<&str>, pane: &str, states: &[String], timeout: u64) -> i32 {
    let Ok(pane) = uuid::Uuid::parse_str(pane) else {
        return fail(&format!("{pane} is not a pane ID"));
    };
    if let Err(error) = crate::automation::parse_states(states) {
        return fail(&error);
    }
    let timeout = Duration::from_secs(timeout).min(crate::automation::MAX_WAIT);
    let mut path = format!("/api/panes/{pane}/wait?timeout_ms={}", timeout.as_millis());
    if !states.is_empty() {
        path.push_str(&format!("&states={}", states.join(",")));
    }
    match get(profile, &path, timeout + Duration::from_secs(10)).await {
        Ok((outcome, body)) => {
            println!("{body}");
            if outcome["timed_out"] == true {
                2
            } else {
                0
            }
        }
        Err(error) => fail(&error),
    }
}

fn fail(error: &str) -> i32 {
    eprintln!("btmux: {error}");
    1
}

async fn get(
    profile: Option<&str>,
    path: &str,
    timeout: Duration,
) -> Result<(serde_json::Value, String), String> {
    let body = request(profile, Method::GET, path, None, timeout).await?;
    let value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok((value, body))
}
