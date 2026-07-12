use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::BtmuxMcpServer;
use crate::api;
use crate::ws::control::broadcast_state;

fn parse_uuid(s: &str, field: &str) -> Result<Uuid, ErrorData> {
    Uuid::parse_str(s)
        .map_err(|_| ErrorData::invalid_params(format!("{field} is not a valid UUID: {s}"), None))
}

fn ok_json<T: Serialize>(value: T) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::json(value)?]))
}

fn ok_text(text: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(text.into())]))
}

/// A request that's well-formed but didn't succeed for a reason the caller
/// should see (not found, guard violation, ...). Per `rmcp`'s own
/// documented convention (`CallToolResult::error`'s doc comment): this is
/// rendered to the agent, unlike `Err(ErrorData)` which MCP clients render
/// opaquely. Reserve `Err(ErrorData::invalid_params(...))` for malformed
/// requests the caller could have validated itself (bad UUID, bad enum).
fn tool_error(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(msg.into())]))
}

#[derive(Deserialize, JsonSchema)]
struct GetSessionParams {
    session_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct CreateSessionParams {
    name: Option<String>,
    cwd: Option<String>,
    window_name: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct CreateWindowParams {
    session_id: String,
    name: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct SplitPaneParams {
    session_id: String,
    pane_id: String,
    /// One of: left, right, up, down.
    direction: String,
}

#[derive(Deserialize, JsonSchema)]
struct PaneRefParams {
    session_id: String,
    pane_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SessionRefParams {
    session_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SendKeysParams {
    pane_id: String,
    /// Sent verbatim — no implicit Enter. Use e.g. "\r" for Enter, "\x03" for Ctrl-C.
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct ReadPaneOutputParams {
    pane_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct RunCommandParams {
    pane_id: String,
    command: String,
    /// Milliseconds of no new output before the command is considered settled. Default 400.
    idle_ms: Option<u64>,
    /// Overall cap in milliseconds regardless of idle state. Default 15000.
    timeout_ms: Option<u64>,
}

#[tool_router(vis = "pub(crate)")]
impl BtmuxMcpServer {
    #[tool(description = "List all sessions (id and name).")]
    async fn list_sessions(&self) -> Result<CallToolResult, ErrorData> {
        let mgr = self.state.read().await;
        ok_json(mgr.session_summaries())
    }

    #[tool(description = "Get full detail (windows, panes, layout) for one session.")]
    async fn get_session(
        &self,
        Parameters(GetSessionParams { session_id }): Parameters<GetSessionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = parse_uuid(&session_id, "session_id")?;
        let mgr = self.state.read().await;
        match mgr.snapshot_by_id(session_id) {
            Some(snapshot) => ok_json(snapshot),
            None => tool_error(format!("session {session_id} not found")),
        }
    }

    #[tool(
        description = "Create a new session, optionally with a name, starting cwd, and initial window name."
    )]
    async fn create_session(
        &self,
        Parameters(CreateSessionParams {
            name,
            cwd,
            window_name,
        }): Parameters<CreateSessionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = cwd.map(std::path::PathBuf::from);
        let mut mgr = self.state.write().await;
        let id = mgr
            .create_session_with_cwd_and_window(name, cwd, window_name)
            .await;
        let name = mgr
            .sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        broadcast_state(&mgr);
        ok_json(serde_json::json!({"id": id, "name": name}))
    }

    #[tool(description = "Create a new window in a session, optionally with a name and starting cwd.")]
    async fn create_window(
        &self,
        Parameters(CreateWindowParams {
            session_id,
            name,
            cwd,
        }): Parameters<CreateWindowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = parse_uuid(&session_id, "session_id")?;
        let cwd = cwd.map(std::path::PathBuf::from);
        let mut mgr = self.state.write().await;
        if !api::session_exists(&mgr, session_id) {
            return tool_error(format!("session {session_id} not found"));
        }
        mgr.create_window_named(session_id, name, cwd).await;
        broadcast_state(&mgr);
        ok_json(serde_json::json!({"session_id": session_id}))
    }

    #[tool(description = "Split a pane. direction must be one of: left, right, up, down.")]
    async fn split_pane(
        &self,
        Parameters(SplitPaneParams {
            session_id,
            pane_id,
            direction,
        }): Parameters<SplitPaneParams>,
    ) -> Result<CallToolResult, ErrorData> {
        if !["left", "right", "up", "down"].contains(&direction.as_str()) {
            return Err(ErrorData::invalid_params(
                format!("direction must be one of left/right/up/down, got '{direction}'"),
                None,
            ));
        }
        let session_id = parse_uuid(&session_id, "session_id")?;
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let mut mgr = self.state.write().await;
        match api::pane_in_active_window(&mgr, session_id, pane_id) {
            None => return tool_error(format!("session {session_id} not found")),
            Some(false) => {
                return tool_error(format!(
                    "pane {pane_id} is not in session {session_id}'s active window"
                ))
            }
            Some(true) => {}
        }
        mgr.split_pane(session_id, pane_id, direction).await;
        broadcast_state(&mgr);
        ok_text("ok")
    }

    #[tool(description = "Kill a pane.")]
    async fn kill_pane(
        &self,
        Parameters(PaneRefParams {
            session_id,
            pane_id,
        }): Parameters<PaneRefParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = parse_uuid(&session_id, "session_id")?;
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let mut mgr = self.state.write().await;
        match api::pane_in_active_window(&mgr, session_id, pane_id) {
            None => return tool_error(format!("session {session_id} not found")),
            Some(false) => {
                return tool_error(format!(
                    "pane {pane_id} is not in session {session_id}'s active window"
                ))
            }
            Some(true) => {}
        }
        mgr.kill_pane(session_id, pane_id);
        broadcast_state(&mgr);
        ok_text("ok")
    }

    #[tool(description = "Close the active window of a session. Fails if it's the session's last window.")]
    async fn close_window(
        &self,
        Parameters(SessionRefParams { session_id }): Parameters<SessionRefParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = parse_uuid(&session_id, "session_id")?;
        let mut mgr = self.state.write().await;
        let Some(session) = mgr.sessions.iter().find(|s| s.id == session_id) else {
            return tool_error(format!("session {session_id} not found"));
        };
        if session.windows.len() <= 1 {
            return tool_error("cannot close the last window in a session");
        }
        mgr.close_window(session_id);
        broadcast_state(&mgr);
        ok_text("ok")
    }

    #[tool(description = "Kill a session. Fails if it's the last remaining session.")]
    async fn kill_session(
        &self,
        Parameters(SessionRefParams { session_id }): Parameters<SessionRefParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = parse_uuid(&session_id, "session_id")?;
        let mut mgr = self.state.write().await;
        if !api::session_exists(&mgr, session_id) {
            return tool_error(format!("session {session_id} not found"));
        }
        if mgr.sessions.len() <= 1 {
            return tool_error("cannot kill the last remaining session");
        }
        mgr.kill_session(session_id);
        broadcast_state(&mgr);
        ok_text("ok")
    }

    #[tool(
        description = "Send raw text into a pane's shell, verbatim -- no implicit Enter. Use for interactive control (e.g. \"\\x03\" for Ctrl-C) or partial input. For \"run a command and see its output\" use run_command instead."
    )]
    async fn send_keys(
        &self,
        Parameters(SendKeysParams { pane_id, text }): Parameters<SendKeysParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let mut mgr = self.state.write().await;
        let Some(pane) = mgr.find_pane_mut(pane_id) else {
            return tool_error(format!("pane {pane_id} not found"));
        };
        let newly_spawned = !pane.pty.is_spawned();
        pane.pty.ensure_spawned(80, 24);
        let _ = pane.pty.input_tx.send(text.into_bytes());
        ok_json(serde_json::json!({"newly_spawned": newly_spawned}))
    }

    #[tool(
        description = "Read a pane's current scrollback as clean text (ANSI escapes stripped), without sending any input."
    )]
    async fn read_pane_output(
        &self,
        Parameters(ReadPaneOutputParams { pane_id }): Parameters<ReadPaneOutputParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let mut mgr = self.state.write().await;
        let Some(pane) = mgr.find_pane_mut(pane_id) else {
            return tool_error(format!("pane {pane_id} not found"));
        };
        pane.pty.ensure_spawned(80, 24);
        let (_rx, scrollback) = pane.pty.subscribe_and_get_scrollback();
        let cleaned = strip_ansi_escapes::strip(&scrollback);
        ok_text(String::from_utf8_lossy(&cleaned).into_owned())
    }

    #[tool(
        description = "Send a command to a pane and wait for its output to settle (or timeout_ms to elapse), returning the cleaned output produced since sending. Appends Enter automatically. Note: timed_out=false means the pane went quiet for idle_ms, not that the command necessarily finished -- a command that runs silently (e.g. a long sleep) will also look 'settled'. If you need to be sure a command finished, look for its actual completion signal in the output, or follow up with read_pane_output later."
    )]
    async fn run_command(
        &self,
        Parameters(RunCommandParams {
            pane_id,
            command,
            idle_ms,
            timeout_ms,
        }): Parameters<RunCommandParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        match super::run_command::run_command(&self.state, pane_id, &command, idle_ms, timeout_ms).await {
            Ok(outcome) => ok_json(serde_json::json!({
                "output": outcome.output,
                "timed_out": outcome.timed_out,
            })),
            Err(msg) => tool_error(msg),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BtmuxMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Control btmux (browser-based tmux) sessions, windows, and panes.")
    }
}
