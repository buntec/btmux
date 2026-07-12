use std::time::Duration;

use tokio::sync::broadcast;
use uuid::Uuid;

use crate::AppState;

const DEFAULT_IDLE_MS: u64 = 400;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

pub struct RunCommandOutcome {
    pub output: String,
    pub timed_out: bool,
}

/// Sends `command` (plus a trailing `\r` — see `capture_pane_to_editor`'s
/// comment in `session/manager.rs` on why shells expect `\r` rather than
/// `\n` for Enter) into a pane's PTY, then waits for output to go quiet
/// (`idle_ms` with no new bytes) or `timeout_ms` to elapse, whichever comes
/// first. Event-driven — subscribes to the pane's live output broadcast
/// channel rather than polling.
///
/// Returns `Err(message)` for a domain-level failure (e.g. pane not found)
/// rather than a `rmcp::ErrorData` protocol error, so the caller in
/// `tools.rs` can surface it as a caller-visible `CallToolResult::error`
/// instead of an opaque JSON-RPC error the agent's client won't render.
pub async fn run_command(
    state: &AppState,
    pane_id: Uuid,
    command: &str,
    idle_ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<RunCommandOutcome, String> {
    // Brief write-lock section: find the pane, ensure its shell is running,
    // subscribe to output *before* sending input (so the first bytes of the
    // command's own output can't be missed), then send. The guard is dropped
    // before the wait below — holding it across up to `timeout_ms` would
    // block every other REST/WS/MCP request against the whole session tree.
    let mut rx: broadcast::Receiver<Vec<u8>> = {
        let mut mgr = state.write().await;
        let Some(pane) = mgr.find_pane_mut(pane_id) else {
            return Err(format!("pane {pane_id} not found"));
        };
        pane.pty.ensure_spawned(DEFAULT_COLS, DEFAULT_ROWS);
        let (rx, _snapshot) = pane.pty.subscribe_and_get_scrollback();
        let mut line = command.as_bytes().to_vec();
        line.push(b'\r');
        let _ = pane.pty.input_tx.send(line);
        rx
    };

    let mut acc: Vec<u8> = Vec::new();
    let idle = Duration::from_millis(idle_ms.unwrap_or(DEFAULT_IDLE_MS));
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let mut timed_out = false;

    loop {
        if tokio::time::Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Ok(bytes) => acc.extend_from_slice(&bytes),
                // Reader thread outpaced the broadcast channel (capacity 256,
                // see PtyHandle::new_with_cwd) — some middle chunks were
                // dropped. Pre-existing limitation of the broadcast design;
                // keep going rather than aborting the capture.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = tokio::time::sleep(idle) => break,
            _ = tokio::time::sleep_until(deadline) => { timed_out = true; break; }
        }
    }

    let cleaned = strip_ansi_escapes::strip(&acc);
    Ok(RunCommandOutcome {
        output: String::from_utf8_lossy(&cleaned).into_owned(),
        timed_out,
    })
}
