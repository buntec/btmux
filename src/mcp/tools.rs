use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ServerCapabilities, ServerConfig};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::BtmuxMcpServer;
use crate::api;
use crate::automation;
use crate::pty::screen::MAX_CAPTURE_HISTORY;
use crate::ws::control::broadcast_state;

fn parse_uuid(s: &str, field: &str) -> Result<Uuid, ErrorData> {
    Uuid::parse_str(s)
        .map_err(|_| ErrorData::invalid_params(format!("{field} is not a valid UUID: {s}"), None))
}

fn ok_json<T: Serialize>(value: T) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::json(value)?]))
}

fn ok_text(text: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(
        text.into(),
    )]))
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

fn automation_error(error: automation::Error) -> Result<CallToolResult, ErrorData> {
    match error {
        automation::Error::Invalid(message) => Err(ErrorData::invalid_params(message, None)),
        error => tool_error(error.to_string()),
    }
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
struct CreateWorktreeParams {
    /// A pane in the repo; the window opens in its session.
    pane_id: String,
    /// An existing local or remote branch, or a new one from the pane's HEAD.
    branch: String,
    /// Make the new window active. Default true.
    select: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct RemoveWorktreeParams {
    /// A pane in the worktree.
    pane_id: String,
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
    /// Sent verbatim, before `keys`. No implicit Enter.
    text: Option<String>,
    /// tmux-style key names sent after `text`, e.g. ["Enter"], ["C-c"], ["Escape"], ["Up"], ["M-x"], ["F5"].
    keys: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
struct ReadPaneOutputParams {
    pane_id: String,
    /// Include scrollback above the screen. Default false (screen only).
    scrollback: Option<bool>,
    /// Return only the last N lines.
    lines: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct WaitForAgentParams {
    pane_id: String,
    /// Agent states to wait for: idle, working, blocked, done, unknown. Default ["idle", "done", "blocked"].
    states: Option<Vec<String>>,
    /// Default 600000 (10 minutes), at most 3600000.
    timeout_ms: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
struct SendPromptParams {
    pane_id: String,
    /// Prompt text; may span lines. Submitted with Enter.
    prompt: String,
    /// Wait for the agent to finish its turn. Default true.
    wait: Option<bool>,
    /// Default 600000 (10 minutes), at most 3600000.
    timeout_ms: Option<u64>,
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
        let session = mgr.sessions.iter().find(|s| s.id == id).unwrap();
        let name = session.name.clone();
        let pane_id = session.windows[0].panes[0].id;
        broadcast_state(&mgr);
        ok_json(serde_json::json!({"id": id, "name": name, "pane_id": pane_id}))
    }

    #[tool(
        description = "Create a new window in a session, optionally with a name and starting cwd."
    )]
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
        let pane_id = mgr.create_window_named(session_id, name, cwd, true).await;
        broadcast_state(&mgr);
        ok_json(serde_json::json!({"session_id": session_id, "pane_id": pane_id}))
    }

    #[tool(
        description = "Create a git worktree for a branch beside the repo's main worktree (the `worktree-path` setting) and open a window there in the pane's session. Returns the new pane's ID and the worktree path."
    )]
    async fn create_worktree(
        &self,
        Parameters(CreateWorktreeParams {
            pane_id,
            branch,
            select,
        }): Parameters<CreateWorktreeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        match crate::worktree::create(&self.state, pane_id, &branch, select.unwrap_or(true)).await {
            Ok(created) => ok_json(created),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "Remove the linked git worktree a pane is in and close every pane in it. Refuses the main worktree, uncommitted changes, a locked worktree, and panes running a program. The branch is kept."
    )]
    async fn remove_worktree(
        &self,
        Parameters(RemoveWorktreeParams { pane_id }): Parameters<RemoveWorktreeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        match crate::worktree::remove(&self.state, pane_id).await {
            Ok(removed) => ok_json(removed),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "Split a pane, returning the new pane's ID. direction is where the new pane goes: left, right, up, or down."
    )]
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
        let pane_id = mgr.split_pane(pane_id, &direction, None, true).await;
        broadcast_state(&mgr);
        ok_json(serde_json::json!({"pane_id": pane_id}))
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

    #[tool(
        description = "Close the active window of a session. Fails if it's the session's last window."
    )]
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
        description = "Type into a pane: `text` verbatim (no implicit Enter), then tmux-style `keys` such as [\"Enter\"] or [\"C-c\"]. For agent prompts use send_prompt; for shell commands use run_command."
    )]
    async fn send_keys(
        &self,
        Parameters(SendKeysParams {
            pane_id,
            text,
            keys,
        }): Parameters<SendKeysParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        match automation::send_keys(
            &self.state,
            pane_id,
            &text.unwrap_or_default(),
            &keys.unwrap_or_default(),
            None,
        )
        .await
        {
            Ok(newly_spawned) => ok_json(serde_json::json!({"newly_spawned": newly_spawned})),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "Read a pane as rendered text, like `tmux capture-pane -pJ`: the visible screen, or with scrollback=true the retained history above it too. Wrapped lines are joined; no ANSI escapes."
    )]
    async fn read_pane_output(
        &self,
        Parameters(ReadPaneOutputParams {
            pane_id,
            scrollback,
            lines,
        }): Parameters<ReadPaneOutputParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let history = if scrollback.unwrap_or(false) {
            MAX_CAPTURE_HISTORY
        } else {
            0
        };
        match automation::capture_pane(&self.state, pane_id, history, lines).await {
            Ok(text) => ok_text(text),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "List panes running a coding agent (Claude Code, Codex, Gemini CLI, ...) across all sessions, with each agent's state: working, blocked (waiting for approval or input), done (finished a turn nobody has looked at yet), idle, or unknown."
    )]
    async fn list_agents(&self) -> Result<CallToolResult, ErrorData> {
        ok_json(self.state.read().await.agent_panes())
    }

    #[tool(
        description = "Wait until a pane's agent reaches one of `states` (default idle, done, or blocked) or exits; status is null once it has exited. A pane with no agent yet is waited on, so this can follow launching one. Returns immediately if the agent is already in such a state; to wait for a reply to a new prompt, use send_prompt."
    )]
    async fn wait_for_agent(
        &self,
        Parameters(WaitForAgentParams {
            pane_id,
            states,
            timeout_ms,
        }): Parameters<WaitForAgentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        let states = match states {
            Some(names) => {
                automation::parse_states(&names).map_err(|e| ErrorData::invalid_params(e, None))?
            }
            None => automation::SETTLED.to_vec(),
        };
        match automation::wait_for_agent(
            &self.state,
            pane_id,
            &states,
            automation::wait_duration(timeout_ms),
        )
        .await
        {
            Ok(outcome) => ok_json(outcome),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "Submit a prompt to the agent in a pane: pastes it, then presses Enter. By default waits until the agent starts and then settles (idle, done, or blocked) and returns its status and rendered screen; started=false means no turn was seen starting. With wait=false, returns {submitted: true} once Enter is sent. Refuses while the agent is blocked or a dialog is on screen, since typing would answer it; while its state is unknown or detection has stalled; and, when waiting, while it is working, since the turn that ends would not be this one. A dialog seen just before the Enter leaves the prompt pasted but not submitted."
    )]
    async fn send_prompt(
        &self,
        Parameters(SendPromptParams {
            pane_id,
            prompt,
            wait,
            timeout_ms,
        }): Parameters<SendPromptParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane_id = parse_uuid(&pane_id, "pane_id")?;
        match automation::send_prompt(
            &self.state,
            pane_id,
            &prompt,
            wait.unwrap_or(true),
            automation::wait_duration(timeout_ms),
        )
        .await
        {
            Ok(Some(outcome)) => ok_json(outcome),
            Ok(None) => ok_json(serde_json::json!({"submitted": true})),
            Err(error) => automation_error(error),
        }
    }

    #[tool(
        description = "Describe the machine btmux and its shells run on, fastfetch-style: user, host name, OS, hardware model, kernel, uptime, default shell, CPU, memory, swap, disks, local IPv4 addresses, load average, process count, and locale. Sizes are in bytes, uptime in seconds."
    )]
    async fn system_info(&self) -> Result<CallToolResult, ErrorData> {
        ok_json(crate::system_info::report(&self.state).await)
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
        match super::run_command::run_command(&self.state, pane_id, &command, idle_ms, timeout_ms)
            .await
        {
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
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Control btmux (browser-based tmux) sessions, windows, and panes.")
    }
}
