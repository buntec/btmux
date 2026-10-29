use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::detection::{Detection, DetectionInput, Detector};
use super::{AgentState, AgentStatus};
use crate::pty::screen::ScreenSnapshot;

pub const UNVERIFIED_AGENT_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_RETIRED: usize = 8;
const MAX_PARKED: usize = 4;

/// Numbers each agent instance a lifecycle tracks.
static NEXT_INCARNATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_incarnation() -> u64 {
    NEXT_INCARNATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Names a tool call across its permission and completion hooks.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolCall {
    pub id: Option<String>,
    /// For hooks without an id (Claude Code's PermissionRequest).
    pub input: Option<ToolInput>,
}

impl ToolCall {
    /// Whether `later` is this call: by id when both have one, else by input.
    pub fn matches(&self, later: &ToolCall) -> bool {
        match (&self.id, &later.id) {
            (Some(id), Some(later)) => id == later,
            _ => self
                .input
                .as_ref()
                .zip(later.input.as_ref())
                .is_some_and(|(input, later)| input.covered_by(later)),
        }
    }
}

/// A tool name and a hash of each top-level input field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolInput {
    name: String,
    fields: Vec<u64>,
}

impl ToolInput {
    pub fn new(name: String, input: &serde_json::Value) -> Self {
        use std::hash::{Hash, Hasher};
        let hash = |key: &str, value: &serde_json::Value| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (key, value.to_string()).hash(&mut hasher);
            hasher.finish()
        };
        let mut fields: Vec<u64> = match input {
            serde_json::Value::Object(map) => map.iter().map(|(k, v)| hash(k, v)).collect(),
            other => vec![hash("", other)],
        };
        fields.sort_unstable();
        fields.dedup();
        Self { name, fields }
    }

    /// Whether `later` has every field of this input. Approval can add fields
    /// (AskUserQuestion's answers) before the completion hook.
    fn covered_by(&self, later: &ToolInput) -> bool {
        self.name == later.name
            && self
                .fields
                .iter()
                .all(|field| later.fields.binary_search(field).is_ok())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct AgentProcess {
    pub pid: u32,
    pub start_time: u64,
}

pub struct PaneProcess {
    pub pid: u32,
    pub parent: Option<u32>,
    pub start_time: u64,
    pub name: String,
    pub command: Vec<String>,
    pub process_group: Option<u32>,
}

pub fn detect_pane_agents(
    processes: &[PaneProcess],
    pane_shells: &[(Uuid, u32, Option<u32>)],
) -> Vec<(Uuid, AgentProcess, String)> {
    let parents: HashMap<_, _> = processes.iter().map(|p| (p.pid, p.parent)).collect();
    let shells: HashMap<_, _> = pane_shells
        .iter()
        .map(|(pane, pid, foreground)| (*pid, (*pane, *foreground)))
        .collect();
    let mut found = HashMap::new();
    for process in processes {
        let Some(agent) = agent_name(process) else {
            continue;
        };
        let mut current = Some(process.pid);
        for _ in 0..64 {
            let Some(pid) = current else { break };
            if let Some((pane_id, foreground)) = shells.get(&pid) {
                let identity = AgentProcess {
                    pid: process.pid,
                    start_time: process.start_time,
                };
                let in_foreground =
                    process.process_group.is_some() && process.process_group == *foreground;
                let entry = found
                    .entry(*pane_id)
                    .or_insert_with(|| (identity, agent.to_string(), in_foreground));
                if (in_foreground && !entry.2)
                    || (in_foreground == entry.2
                        && (identity.start_time, identity.pid) < (entry.0.start_time, entry.0.pid))
                {
                    *entry = (identity, agent.to_string(), in_foreground);
                }
                break;
            }
            current = parents.get(&pid).copied().flatten();
        }
    }
    found
        .into_iter()
        .map(|(pane_id, (process, name, _))| (pane_id, process, name))
        .collect()
}

pub fn agent_name(process: &PaneProcess) -> Option<&'static str> {
    let executable = process
        .command
        .first()
        .map(String::as_str)
        .unwrap_or(&process.name);
    let basename = |path: &str| {
        Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    };
    let name = basename(executable);
    let (name, args) = if matches!(name.as_str(), "node" | "nodejs" | "bun") {
        let script = process.command.get(1)?;
        let script_name = basename(script);
        let agent = match script_name.as_str() {
            "codex" | "codex.js" => "codex",
            "claude" | "claude.js" => "claude",
            "gemini" | "gemini.js" => "gemini",
            "cli.js" | "index.js" if script.contains("/@anthropic-ai/claude-code/") => "claude",
            "cli.js" | "index.js" if script.contains("/@google/gemini-cli/") => "gemini",
            "cli.js" | "index.js" if script.contains("/@openai/codex/") => "codex",
            _ => return None,
        };
        (agent.to_string(), &process.command[2..])
    } else {
        (name, process.command.get(1..).unwrap_or_default())
    };
    match name.as_str() {
        "codex"
            if !args.first().is_some_and(|arg| {
                matches!(
                    arg.as_str(),
                    "app-server" | "mcp-server" | "completion" | "exec" | "e" | "review"
                )
            }) =>
        {
            Some("codex")
        }
        "claude"
            if !args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--print" | "-p" | "mcp")) =>
        {
            Some("claude")
        }
        "opencode"
            if !args.first().is_some_and(|arg| {
                matches!(
                    arg.as_str(),
                    "run" | "serve" | "web" | "acp" | "mcp" | "models" | "auth" | "upgrade"
                )
            }) =>
        {
            Some("opencode")
        }
        "agy"
            if !args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--print" | "--prompt" | "-p")) =>
        {
            Some("agy")
        }
        "gemini"
            if !args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--prompt" | "-p")) =>
        {
            Some("gemini")
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentEvent {
    SessionStart,
    SessionEnd,
    TurnStart,
    PermissionRequest,
    ToolFinished,
    TurnFinished,
    Interrupt,
}

pub struct AgentReport {
    pub event: AgentEvent,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    /// The tool call a permission or completion belongs to.
    pub tool: Option<ToolCall>,
    pub process: Option<AgentProcess>,
    pub agent: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
}

/// Evidence that set the current status. Later variants win conflicts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Authority {
    /// Process presence only; activity unknown.
    Process,
    /// Screen manifest rules.
    Screen,
    /// Structured lifecycle reports from the agent.
    Hook,
    /// `POST /agent-status`; screen detection never overrides it.
    Explicit,
}

/// Screen-only flicker guard for working/blocked -> idle/unknown.
const SCREEN_SETTLE: Duration = Duration::from_millis(700);
/// How long positive screen evidence must contradict a hook before winning.
const HOOK_OVERRIDE_SETTLE: Duration = Duration::from_millis(1500);

pub struct AgentLifecycle {
    pub status: AgentStatus,
    authority: Authority,
    session_id: Option<String>,
    turn_id: Option<String>,
    turn_complete: bool,
    blocked_tool: Option<ToolCall>,
    /// Changes whenever another agent instance takes over this lifecycle.
    incarnation: u64,
    /// Identity reported by hooks (may be a wrapper's child).
    process: Option<AgentProcess>,
    /// Identity selected by the process scan; also keys the manifest.
    observed: Option<AgentProcess>,
    observed_name: Option<String>,
    named_by_report: bool,
    last_seen: Instant,
    ended: bool,
    ended_process: Option<AgentProcess>,
    retired_sessions: Vec<String>,
    /// Finished or replaced turns of this session.
    retired_turns: Vec<String>,
    /// Other live agents in the pane, outside the foreground.
    parked: Vec<AgentLifecycle>,
    pub detection: Option<Detection>,
    screen_revision: Option<u64>,
    signal_floor: u64,
    screen_floor: Option<u64>,
    pending_screen: Option<(AgentState, Instant)>,
}

impl AgentLifecycle {
    pub fn detected(process: AgentProcess, name: String, now: Instant) -> Self {
        let mut lifecycle = Self::new(
            AgentStatus {
                state: AgentState::Unknown,
                agent: Some(name.clone()),
                source: Some("process".to_string()),
                message: None,
            },
            Authority::Process,
            now,
        );
        lifecycle.observed = Some(process);
        lifecycle.observed_name = Some(name);
        lifecycle
    }

    pub fn explicit(status: AgentStatus, now: Instant) -> Self {
        Self::new(status, Authority::Explicit, now)
    }

    pub fn reported(now: Instant) -> Self {
        Self::new(
            AgentStatus {
                state: AgentState::Idle,
                ..AgentStatus::default()
            },
            Authority::Hook,
            now,
        )
    }

    fn new(status: AgentStatus, authority: Authority, now: Instant) -> Self {
        Self {
            status,
            authority,
            session_id: None,
            turn_id: None,
            turn_complete: false,
            blocked_tool: None,
            incarnation: next_incarnation(),
            process: None,
            observed: None,
            observed_name: None,
            named_by_report: false,
            last_seen: now,
            ended: false,
            ended_process: None,
            retired_sessions: Vec::new(),
            retired_turns: Vec::new(),
            parked: Vec::new(),
            detection: None,
            screen_revision: None,
            signal_floor: 0,
            screen_floor: None,
            pending_screen: None,
        }
    }

    pub fn observe_process(
        &mut self,
        process: AgentProcess,
        name: &str,
        revision: u64,
        now: Instant,
        alive: impl Fn(AgentProcess) -> bool,
    ) -> bool {
        // Hooks may report a wrapper's child; only the scan's own choice
        // identifies a replacement.
        let replaced = self.ended || self.observed.is_some_and(|current| current != process);
        if replaced {
            let mut previous = std::mem::replace(self, Self::detected(process, name.into(), now));
            let mut parked = std::mem::take(&mut previous.parked);
            let mut retired = std::mem::take(&mut previous.retired_sessions);
            parked.retain(|agent| agent.observed.is_some_and(&alive));
            // A live agent that left the foreground (e.g. suspended) keeps its
            // hook session until it returns.
            if !previous.ended && previous.observed.is_some_and(&alive) {
                parked.push(previous);
            } else if let Some(session) = previous.session_id {
                retired.push(session);
            }
            if let Some(index) = parked
                .iter()
                .position(|agent| agent.observed == Some(process))
            {
                *self = parked.remove(index);
            }
            parked.drain(..parked.len().saturating_sub(MAX_PARKED));
            retired.drain(..retired.len().saturating_sub(MAX_RETIRED));
            self.parked = parked;
            self.retired_sessions = retired;
            self.suppress_old_screen(revision);
            return true;
        }
        self.observed = Some(process);
        self.observed_name = Some(name.to_string());
        // A reported name outranks the process-derived one.
        if self.named_by_report || self.status.agent.as_deref() == Some(name) {
            return false;
        }
        self.status.agent = Some(name.to_string());
        true
    }

    pub fn process(&self) -> Option<AgentProcess> {
        self.observed.or(self.process)
    }

    pub fn observed_process(&self) -> Option<AgentProcess> {
        self.observed
    }

    /// The manifest that reads this agent's screen, if any does.
    pub fn screen_manifest(&self) -> Option<&str> {
        self.observed_name
            .as_deref()
            .filter(|_| self.reads_screen())
    }

    pub fn blocked_tool(&self) -> Option<&ToolCall> {
        self.blocked_tool.as_ref()
    }

    /// Stays the same while one agent instance runs, though its reported
    /// process may change from a hook's child to the scanned wrapper.
    pub fn incarnation(&self) -> u64 {
        self.incarnation
    }

    pub fn authority(&self) -> Authority {
        self.authority
    }

    fn reads_screen(&self) -> bool {
        !self.ended && self.observed.is_some() && self.authority != Authority::Explicit
    }

    /// Whether a screen at `revision` could change this lifecycle.
    pub fn wants_screen(&self, revision: u64) -> bool {
        self.reads_screen()
            && !self.screen_floor.is_some_and(|floor| revision <= floor)
            && (self.screen_revision != Some(revision) || self.pending_screen.is_some())
    }

    /// A suspended or background agent's activity is unknown, and the screen
    /// belongs to another program.
    pub fn observe_background(&mut self, revision: u64) -> bool {
        if !self.reads_screen() {
            return false;
        }
        self.screen_revision = None;
        self.pending_screen = None;
        self.signal_floor = revision;
        self.screen_floor = Some(revision);
        let previous = self.status.clone();
        self.status.state = AgentState::Unknown;
        self.status.source = Some("process".into());
        self.status.message = None;
        self.authority = Authority::Process;
        self.detection = None;
        self.status != previous
    }

    pub fn scan_screen(
        &mut self,
        detector: &Detector,
        screen: &ScreenSnapshot,
        now: Instant,
    ) -> bool {
        if !self.wants_screen(screen.revision) {
            return false;
        }
        self.screen_floor = None;
        self.screen_revision = Some(screen.revision);
        let Some(mut detection) = self.detect(detector, screen) else {
            return false;
        };
        detection.screen_revision = screen.revision;
        let Some((state, settle)) = self.screen_verdict(&detection) else {
            self.detection = Some(detection);
            self.pending_screen = None;
            return false;
        };
        self.detection = Some(detection);
        if let Some(settle) = settle {
            let started = match &self.pending_screen {
                Some((pending, started)) if *pending == state => *started,
                _ => {
                    self.pending_screen = Some((state, now));
                    return false;
                }
            };
            if now.duration_since(started) < settle {
                return false;
            }
        }
        self.pending_screen = None;
        let previous = self.status.clone();
        self.status.state = state;
        self.status.source = Some("screen".into());
        self.status.message = None;
        self.authority = Authority::Screen;
        self.status != previous
    }

    /// Detects `screen`, ignoring OSC signals a prior program left.
    pub fn detect(&self, detector: &Detector, screen: &ScreenSnapshot) -> Option<Detection> {
        let name = self.screen_manifest()?;
        detector.detect(
            name,
            DetectionInput {
                screen: &screen.text,
                osc_title: if screen.title_revision > self.signal_floor {
                    &screen.title
                } else {
                    ""
                },
                osc_progress: if screen.progress_revision > self.signal_floor {
                    &screen.progress
                } else {
                    ""
                },
            },
        )
    }

    /// The state a detection may impose, and how long it must persist first.
    /// Unmatched or unknown screens never override other evidence, and
    /// agreeing screens leave the reporter's source and message intact.
    fn screen_verdict(&self, detection: &Detection) -> Option<(AgentState, Option<Duration>)> {
        let current = &self.status.state;
        if detection.skip_state_update || detection.state == *current {
            return None;
        }
        // Idle screens do not acknowledge an unread completion.
        if *current == AgentState::Done && detection.state == AgentState::Idle {
            return None;
        }
        let positive = detection.rule.is_some() && detection.state != AgentState::Unknown;
        match self.authority {
            Authority::Explicit => None,
            Authority::Hook => {
                positive.then(|| (detection.state.clone(), Some(HOOK_OVERRIDE_SETTLE)))
            }
            Authority::Process if !positive => None,
            Authority::Process | Authority::Screen => {
                let settle = (matches!(current, AgentState::Working | AgentState::Blocked)
                    && matches!(detection.state, AgentState::Idle | AgentState::Unknown))
                .then_some(SCREEN_SETTLE);
                Some((detection.state.clone(), settle))
            }
        }
    }

    /// Ignores screen and OSC evidence produced before `revision`.
    pub fn suppress_old_screen(&mut self, revision: u64) {
        self.screen_floor = Some(revision);
        self.suppress_old_signals(revision);
    }

    /// Ignores OSC titles and progress produced before `revision`; a fresh
    /// agent repaints its screen but may leave a prior program's title.
    pub fn suppress_old_signals(&mut self, revision: u64) {
        self.signal_floor = revision;
        self.screen_revision = None;
        self.pending_screen = None;
    }

    pub fn ended_process(&self) -> Option<AgentProcess> {
        self.ended_process
    }

    pub fn invalidate_screen(&mut self) {
        self.screen_revision = None;
    }

    pub fn has_observed_process(&self) -> bool {
        self.observed.is_some() && !self.ended
    }

    /// Active only through hook reports, quiet for `grace`. Its reported PID
    /// may be a long-lived server that outlives the agent, so liveness alone
    /// cannot end it.
    pub fn is_unobserved_for(&self, now: Instant, grace: Duration) -> bool {
        self.is_active()
            && self.observed.is_none()
            && self.authority != Authority::Explicit
            && now.duration_since(self.last_seen) >= grace
    }

    pub fn is_stale(&self, now: Instant, process_alive: impl Fn(AgentProcess) -> bool) -> bool {
        if self.ended {
            return now.duration_since(self.last_seen) >= UNVERIFIED_AGENT_TTL;
        }
        match self.observed.or(self.process) {
            Some(process) => !process_alive(process),
            None => now.duration_since(self.last_seen) >= UNVERIFIED_AGENT_TTL,
        }
    }

    /// Returns None for a report belonging to an older session or turn.
    /// Otherwise returns whether the visible status changed.
    /// Accepted reports that assert a state ignore screens before `revision`.
    pub fn apply(&mut self, report: AgentReport, revision: u64, now: Instant) -> Option<bool> {
        if report
            .session_id
            .as_ref()
            .is_some_and(|session| self.retired_sessions.contains(session))
        {
            // The reporter must be the current agent, or a child of it.
            let verified_restart = report.event == AgentEvent::SessionStart
                && report.process.is_some_and(|incoming| {
                    Some(incoming) == self.process
                        || self
                            .observed
                            .is_some_and(|observed| incoming.start_time >= observed.start_time)
                });
            if !verified_restart {
                return None;
            }
            self.retired_sessions
                .retain(|session| Some(session) != report.session_id.as_ref());
        }
        if self.session_id.is_some() && report.session_id.is_none() {
            return None;
        }
        if report.session_id.is_some()
            && self
                .parked
                .iter()
                .any(|agent| agent.session_id == report.session_id)
        {
            return None;
        }
        let different_session = self.session_id.is_some()
            && report.session_id.is_some()
            && self.session_id != report.session_id;
        let starts_session = matches!(
            report.event,
            AgentEvent::SessionStart | AgentEvent::TurnStart
        );
        if self.ended && (!starts_session || (!different_session && self.session_id.is_some())) {
            return None;
        }
        if different_session && !starts_session {
            return None;
        }
        if different_session
            && self
                .process
                .or(self.observed)
                .zip(report.process)
                .is_some_and(|(current, incoming)| incoming.start_time < current.start_time)
        {
            return None;
        }
        let restarted = report.event == AgentEvent::SessionStart
            && !different_session
            && self
                .process
                .zip(report.process)
                .is_some_and(|(current, incoming)| incoming.start_time > current.start_time);

        let same_session = !different_session;
        let turn_sensitive = matches!(
            report.event,
            AgentEvent::PermissionRequest
                | AgentEvent::ToolFinished
                | AgentEvent::TurnFinished
                | AgentEvent::Interrupt
        );
        if turn_sensitive && self.turn_id.is_some() && self.turn_id != report.turn_id {
            return None;
        }
        // Late or repeated reports of a turn that already ended.
        if same_session
            && report
                .turn_id
                .as_ref()
                .is_some_and(|turn| self.retired_turns.contains(turn))
        {
            return None;
        }
        if same_session
            && self.turn_complete
            && matches!(
                report.event,
                AgentEvent::PermissionRequest
                    | AgentEvent::ToolFinished
                    | AgentEvent::TurnFinished
                    | AgentEvent::Interrupt
            )
        {
            return None;
        }

        let previous = self.status.clone();
        self.last_seen = now;
        self.ended = false;
        if different_session || restarted {
            self.status = AgentStatus {
                agent: self.status.agent.take(),
                ..AgentStatus::default()
            };
            self.process = report.process;
            self.incarnation = next_incarnation();
            self.turn_id = None;
            self.turn_complete = false;
            self.blocked_tool = None;
            self.retired_turns.clear();
        }
        if let Some(process) = report.process {
            if self.process.is_none() {
                self.process = Some(process);
            }
        }
        if let Some(session_id) = report.session_id {
            self.session_id = Some(session_id);
        }
        if let Some(agent) = report.agent {
            self.status.agent = Some(agent);
            self.named_by_report = true;
        }

        let asserted = match report.event {
            AgentEvent::SessionStart
                if different_session || restarted || previous.state == AgentState::Unknown =>
            {
                Some((AgentState::Idle, None))
            }
            AgentEvent::SessionStart => None,
            // A repeated start, or input queued into the running turn.
            AgentEvent::TurnStart if report.turn_id.is_some() && report.turn_id == self.turn_id => {
                None
            }
            AgentEvent::TurnStart => {
                self.retire_turn();
                self.turn_id = report.turn_id;
                self.turn_complete = false;
                self.blocked_tool = None;
                Some((AgentState::Working, None))
            }
            AgentEvent::PermissionRequest => {
                self.blocked_tool = report.tool;
                Some((AgentState::Blocked, report.message))
            }
            AgentEvent::ToolFinished => {
                let matches_tool = self.blocked_tool.as_ref().is_none_or(|blocked| {
                    report
                        .tool
                        .as_ref()
                        .is_some_and(|tool| blocked.matches(tool))
                });
                // A finished tool says nothing about a dialog only the screen saw.
                (self.status.state == AgentState::Blocked
                    && self.authority == Authority::Hook
                    && matches_tool)
                    .then(|| {
                        self.blocked_tool = None;
                        (AgentState::Working, None)
                    })
            }
            AgentEvent::TurnFinished => {
                self.retire_turn();
                self.turn_complete = true;
                self.blocked_tool = None;
                Some((AgentState::Done, report.message))
            }
            AgentEvent::Interrupt => {
                self.retire_turn();
                self.turn_complete = true;
                self.blocked_tool = None;
                Some((AgentState::Idle, None))
            }
            AgentEvent::SessionEnd => unreachable!("session end is handled by the manager"),
        };
        if let Some((state, message)) = asserted {
            self.status.state = state;
            self.status.message = message;
            self.status.source = report.source;
            self.authority = Authority::Hook;
            self.suppress_old_screen(revision);
        }
        Some(self.status != previous)
    }

    fn retire_turn(&mut self) {
        let Some(turn) = &self.turn_id else { return };
        if !self.retired_turns.contains(turn) {
            self.retired_turns.push(turn.clone());
            self.retired_turns
                .drain(..self.retired_turns.len().saturating_sub(MAX_RETIRED));
        }
    }

    pub fn matches_session(&self, session_id: Option<&str>) -> bool {
        if self.ended
            || session_id
                .is_some_and(|session| self.retired_sessions.iter().any(|old| old == session))
        {
            return false;
        }
        match (self.session_id.as_deref(), session_id) {
            (Some(current), Some(incoming)) => current == incoming,
            (Some(_), None) => false,
            _ => true,
        }
    }

    pub fn end(&mut self, now: Instant) {
        self.ended_process = self.observed.or(self.process);
        self.status = AgentStatus::default();
        self.authority = Authority::Process;
        self.named_by_report = false;
        self.turn_id = None;
        self.turn_complete = true;
        self.blocked_tool = None;
        self.incarnation = next_incarnation();
        self.process = None;
        self.observed = None;
        self.observed_name = None;
        self.last_seen = now;
        self.ended = true;
        self.detection = None;
        self.pending_screen = None;
    }

    pub fn is_active(&self) -> bool {
        !self.ended
            && (self.observed.is_some()
                || self.process.is_some()
                || self.status.state != AgentState::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_agents_in_each_pane_and_skips_shared_codex_server() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let process = |pid, parent, name: &str, command: &[&str]| PaneProcess {
            pid,
            parent,
            start_time: pid as u64,
            name: name.to_string(),
            command: command.iter().map(|arg| arg.to_string()).collect(),
            process_group: None,
        };
        let processes = [
            process(10, Some(1), "fish", &["fish"]),
            process(11, Some(10), "codex", &["/bin/codex", "--yolo"]),
            process(12, Some(11), "codex", &["/bin/codex", "app-server"]),
            process(20, Some(1), "fish", &["fish"]),
            process(21, Some(20), "codex", &["/bin/codex", "--yolo"]),
        ];
        let detected = detect_pane_agents(&processes, &[(first, 10, None), (second, 20, None)]);
        assert_eq!(detected.len(), 2);
        assert!(detected
            .iter()
            .any(|(pane, agent, _)| *pane == first && agent.pid == 11));
        assert!(detected
            .iter()
            .any(|(pane, agent, _)| *pane == second && agent.pid == 21));
    }

    #[test]
    fn recognizes_runtime_wrappers_and_prefers_foreground_agent() {
        let pane = Uuid::new_v4();
        let make = |pid, command: &[&str], group| PaneProcess {
            pid,
            parent: Some(10),
            start_time: pid as u64,
            name: "node".into(),
            command: command.iter().map(|s| s.to_string()).collect(),
            process_group: Some(group),
        };
        let processes = [
            make(11, &["node", "/npm/@anthropic-ai/claude-code/cli.js"], 11),
            make(12, &["node", "/npm/@google/gemini-cli/dist/index.js"], 12),
            make(13, &["bun", "/bin/codex", "app-server"], 13),
            make(14, &["node", "/tmp/cli.js"], 14),
        ];
        assert_eq!(agent_name(&processes[0]), Some("claude"));
        assert_eq!(agent_name(&processes[1]), Some("gemini"));
        assert_eq!(agent_name(&processes[2]), None);
        assert_eq!(agent_name(&processes[3]), None);
        let detected = detect_pane_agents(&processes, &[(pane, 10, Some(12))]);
        assert_eq!(detected[0].1.pid, 12);
    }

    fn screen(text: &str, title: &str, revision: u64) -> ScreenSnapshot {
        ScreenSnapshot {
            text: text.into(),
            title: title.into(),
            revision,
            title_revision: revision,
            ..Default::default()
        }
    }

    #[test]
    fn screen_recovers_missed_hooks_without_flicker_or_acknowledging_done() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = AgentLifecycle::detected(
            AgentProcess {
                pid: 1,
                start_time: 1,
            },
            "claude".into(),
            now,
        );
        assert!(agent.is_active());
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert!(agent.scan_screen(&detector, &screen("", "⠋ Claude", 1), now));
        assert_eq!(agent.status.state, AgentState::Working);
        let idle = screen("──────\n❯\n──────", "", 2);
        assert!(!agent.scan_screen(&detector, &idle, now));
        assert!(!agent.scan_screen(&detector, &idle, now + Duration::from_millis(300)));
        assert!(agent.scan_screen(&detector, &idle, now + Duration::from_millis(700)));
        assert_eq!(agent.status.state, AgentState::Idle);
        agent.apply(report(AgentEvent::TurnStart, "s", None), 0, now);
        agent.apply(report(AgentEvent::TurnFinished, "s", None), 0, now);
        assert!(!agent.scan_screen(&detector, &screen(&idle.text, "", 3), now));
        assert_eq!(agent.status.state, AgentState::Done);
    }

    #[test]
    fn stale_screens_hooks_and_titles_cannot_overwrite_replacement_process() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = AgentLifecycle::detected(
            AgentProcess {
                pid: 1,
                start_time: 1,
            },
            "codex".into(),
            now,
        );
        agent.apply(report(AgentEvent::TurnStart, "old", None), 0, now);
        let working = screen("", "⠋ Codex", 3);
        agent.suppress_old_screen(3);
        assert!(!agent.scan_screen(&detector, &working, now));
        assert!(agent.observe_process(
            AgentProcess {
                pid: 2,
                start_time: 2
            },
            "codex",
            3,
            now,
            |process| process.pid != 1
        ));
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert!(!agent.scan_screen(&detector, &working, now));
        let new_screen = ScreenSnapshot {
            revision: 4,
            ..working
        };
        assert!(!agent.scan_screen(&detector, &new_screen, now));
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "old", None), 0, now),
            None
        );
        agent.apply(report(AgentEvent::TurnStart, "new", None), 0, now);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "old", None), 0, now),
            None
        );
    }

    const CLAUDE_IDLE: &str = "──────\n❯\n──────";
    const CLAUDE_BLOCKED: &str = "Bash command\n  ls\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n";

    fn claude(now: Instant) -> AgentLifecycle {
        AgentLifecycle::detected(
            AgentProcess {
                pid: 10,
                start_time: 5,
            },
            "claude".into(),
            now,
        )
    }

    #[test]
    fn hooks_from_a_wrapped_child_process_stay_accepted() {
        let now = Instant::now();
        let wrapper = AgentProcess {
            pid: 10,
            start_time: 5,
        };
        let mut agent = claude(now);
        let mut start = report(AgentEvent::SessionStart, "s", None);
        start.process = Some(AgentProcess {
            pid: 11,
            start_time: 6,
        });
        assert_eq!(agent.apply(start, 0, now), Some(true));
        assert!(!agent.observe_process(wrapper, "claude", 1, now, |_| true));
        assert_eq!(
            agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 1, now),
            Some(true)
        );
        assert_eq!(agent.status.state, AgentState::Working);
        assert_eq!(agent.process(), Some(wrapper));
    }

    #[test]
    fn ambiguous_screens_never_override_hooks() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = claude(now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let unmatched = screen("some unrelated redraw", "", 1);
        for ms in [0, 800, 5000] {
            assert!(!agent.scan_screen(&detector, &unmatched, now + Duration::from_millis(ms)));
        }
        assert_eq!(agent.status.state, AgentState::Working);
        assert_eq!(agent.authority(), Authority::Hook);
    }

    #[test]
    fn agreeing_screens_keep_the_hook_source_and_message() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = claude(now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let mut permission = report(AgentEvent::PermissionRequest, "s", Some("t"));
        permission.message = Some("needs Bash".into());
        agent.apply(permission, 0, now);
        assert!(!agent.scan_screen(&detector, &screen(CLAUDE_BLOCKED, "", 1), now));
        assert_eq!(agent.status.source.as_deref(), Some("hook"));
        assert_eq!(agent.status.message.as_deref(), Some("needs Bash"));
        assert_eq!(
            agent.detection.as_ref().and_then(|d| d.rule.as_deref()),
            Some("bash_permission_prompt")
        );
    }

    #[test]
    fn sustained_positive_screens_correct_missed_hooks() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = claude(now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let idle = screen(CLAUDE_IDLE, "", 1);
        assert!(!agent.scan_screen(&detector, &idle, now));
        assert!(!agent.scan_screen(
            &detector,
            &idle,
            now + SCREEN_SETTLE + Duration::from_millis(100)
        ));
        assert_eq!(agent.status.state, AgentState::Working);
        assert!(agent.scan_screen(&detector, &idle, now + HOOK_OVERRIDE_SETTLE));
        assert_eq!(agent.status.state, AgentState::Idle);
        assert_eq!(agent.authority(), Authority::Screen);
        // A fresh hook outranks the screen again.
        agent.apply(report(AgentEvent::TurnStart, "s", Some("u")), 1, now);
        assert!(!agent.scan_screen(&detector, &idle, now + HOOK_OVERRIDE_SETTLE * 2));
        assert_eq!(agent.status.state, AgentState::Working);
    }

    #[test]
    fn screen_blockers_survive_unrelated_tool_completion() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = claude(now);
        assert!(agent.scan_screen(&detector, &screen(CLAUDE_BLOCKED, "", 1), now));
        assert_eq!(agent.status.state, AgentState::Blocked);
        let finished = report(AgentEvent::ToolFinished, "s", None);
        assert_eq!(agent.apply(finished, 1, now), Some(false));
        assert_eq!(agent.status.state, AgentState::Blocked);
    }

    #[test]
    fn explicit_statuses_and_reported_names_outrank_detection() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = AgentLifecycle::explicit(
            AgentStatus {
                state: AgentState::Blocked,
                agent: Some("deploy-bot".into()),
                source: None,
                message: Some("awaiting approval".into()),
            },
            now,
        );
        let process = AgentProcess {
            pid: 10,
            start_time: 5,
        };
        agent.observe_process(process, "claude", 0, now, |_| true);
        let idle = screen(CLAUDE_IDLE, "", 1);
        assert!(!agent.scan_screen(&detector, &idle, now));
        assert!(!agent.scan_screen(&detector, &idle, now + Duration::from_secs(5)));
        assert_eq!(agent.status.state, AgentState::Blocked);
        assert_eq!(agent.status.message.as_deref(), Some("awaiting approval"));

        let mut agent = claude(now);
        let mut start = report(AgentEvent::SessionStart, "s", None);
        start.agent = Some("claude-code".into());
        agent.apply(start, 0, now);
        assert!(!agent.observe_process(process, "claude", 0, now, |_| true));
        assert_eq!(agent.status.agent.as_deref(), Some("claude-code"));
        let working = screen("", "⠋ Claude", 1);
        assert!(!agent.scan_screen(&detector, &working, now));
        assert!(agent.scan_screen(&detector, &working, now + HOOK_OVERRIDE_SETTLE));
        assert_eq!(agent.status.state, AgentState::Working);
    }

    #[test]
    fn a_suspended_agent_keeps_its_hook_session() {
        let now = Instant::now();
        let first = AgentProcess {
            pid: 10,
            start_time: 5,
        };
        let second = AgentProcess {
            pid: 20,
            start_time: 9,
        };
        let mut agent = claude(now);
        agent.apply(report(AgentEvent::TurnStart, "claude", Some("t")), 0, now);
        assert!(agent.observe_background(1));
        assert!(agent.observe_process(second, "codex", 2, now, |_| true));
        assert_eq!(agent.status.agent.as_deref(), Some("codex"));
        assert_eq!(
            agent.apply(
                report(AgentEvent::TurnFinished, "claude", Some("t")),
                2,
                now
            ),
            None
        );
        agent.apply(report(AgentEvent::TurnStart, "codex", None), 2, now);
        // `fg` restores the first agent and its session.
        assert!(agent.observe_process(first, "claude", 3, now, |_| true));
        assert_eq!(agent.status.agent.as_deref(), Some("claude"));
        assert_eq!(
            agent.apply(
                report(AgentEvent::TurnFinished, "claude", Some("t")),
                3,
                now
            ),
            Some(true)
        );
        assert_eq!(agent.status.state, AgentState::Done);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "codex", None), 3, now),
            None
        );
        // An agent that exits retires its session.
        assert!(agent.observe_process(second, "codex", 4, now, |p| p != first));
        assert_eq!(agent.status.agent.as_deref(), Some("codex"));
        assert_eq!(
            agent.apply(report(AgentEvent::TurnStart, "claude", Some("u")), 4, now),
            None
        );
    }

    #[test]
    fn fresh_detection_ignores_a_prior_programs_title() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let mut agent = claude(now);
        agent.suppress_old_signals(1);
        assert!(!agent.scan_screen(&detector, &screen("", "⠋ Claude", 1), now));
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert!(agent.scan_screen(&detector, &screen(CLAUDE_IDLE, "", 2), now));
        assert_eq!(agent.status.state, AgentState::Idle);
    }

    #[test]
    fn prompt_checks_ignore_a_prior_programs_title() {
        let now = Instant::now();
        let detector = Detector::new(None);
        let process = AgentProcess {
            pid: 10,
            start_time: 5,
        };
        let mut agent = AgentLifecycle::detected(process, "codex".into(), now);
        let blocked = |agent: &AgentLifecycle, revision| {
            agent
                .detect(&detector, &screen("", "Action Required", revision))
                .is_some_and(|detection| detection.state == AgentState::Blocked)
        };
        assert!(blocked(&agent, 1));
        agent.suppress_old_signals(1);
        assert!(!blocked(&agent, 1));
        assert!(blocked(&agent, 2));
    }

    #[test]
    fn incarnation_survives_the_scan_naming_a_hook_reported_agent() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::reported(now);
        let child = AgentProcess {
            pid: 11,
            start_time: 6,
        };
        let mut start = report(AgentEvent::SessionStart, "s", None);
        start.process = Some(child);
        agent.apply(start, 0, now);
        let incarnation = agent.incarnation();
        let wrapper = AgentProcess {
            pid: 10,
            start_time: 5,
        };
        agent.observe_process(wrapper, "claude", 1, now, |_| true);
        assert_eq!(agent.process(), Some(wrapper));
        assert_eq!(agent.incarnation(), incarnation);
        let next = AgentProcess {
            pid: 12,
            start_time: 7,
        };
        agent.observe_process(next, "claude", 2, now, |_| true);
        assert_ne!(agent.incarnation(), incarnation);
    }

    /// Claude Code 2.1.312 recordings at 120x40, made with
    /// `scripts/record-agent-replay.py`: one `[seconds, kind, base64]` per
    /// line; kind is `out` (PTY output), `in`, or `note`. Each accepts the
    /// trust dialog, submits a prompt, and answers one dialog. A named session
    /// (`claude -n`) draws its name in a rule below the dialog's footer.
    const CLAUDE_DIALOGS: [&str; 3] = [
        include_str!("detection/fixtures/claude-2.1.312-bash-approval.jsonl"),
        include_str!("detection/fixtures/claude-2.1.312-ask-question.jsonl"),
        include_str!("detection/fixtures/claude-2.1.312-named-ask-question.jsonl"),
    ];

    struct Recording {
        output: Vec<(Duration, Vec<u8>)>,
        notes: HashMap<String, Duration>,
    }

    impl Recording {
        fn parse(text: &str) -> Self {
            use base64::Engine;
            let mut recording = Self {
                output: Vec::new(),
                notes: HashMap::new(),
            };
            for line in text.lines() {
                let (at, kind, data): (f64, String, String) = serde_json::from_str(line).unwrap();
                let at = Duration::from_secs_f64(at);
                let data = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap();
                match kind.as_str() {
                    "out" => recording.output.push((at, data)),
                    "note" => {
                        recording.notes.insert(String::from_utf8(data).unwrap(), at);
                    }
                    _ => {}
                }
            }
            recording
        }

        fn note(&self, name: &str) -> Duration {
            self.notes[name]
        }

        /// Samples the screen every 300 ms (the detector tick) from `offset`.
        fn replay(&self, offset: Duration, mut tick: impl FnMut(Duration, &ScreenSnapshot)) {
            let end = self.output.last().unwrap().0 + Duration::from_secs(2);
            let mut screen = crate::pty::screen::LiveScreen::new(120, 40);
            let mut pending = self.output.iter().enumerate().peekable();
            let mut at = offset;
            while at <= end {
                while let Some((index, (_, bytes))) = pending.next_if(|(_, (t, _))| *t <= at) {
                    let data = crate::pty::replay::Output::Data(bytes.clone().into());
                    screen.push(&data, index as u64 + 1);
                }
                tick(at, &screen.snapshot());
                at += Duration::from_millis(300);
            }
        }
    }

    #[test]
    fn recorded_claude_dialogs_block_with_and_without_hooks() {
        let detector = Detector::new(None);
        for text in CLAUDE_DIALOGS {
            let recording = Recording::parse(text);
            let dialog = recording.note("dialog wait: hit");
            let answered = recording.note("approve");
            // Claude fires PermissionRequest for every dialog, AskUserQuestion included.
            let hooks = [
                (recording.note("submit"), AgentEvent::TurnStart),
                (dialog, AgentEvent::PermissionRequest),
                (answered, AgentEvent::ToolFinished),
                (
                    answered + Duration::from_millis(1700),
                    AgentEvent::TurnFinished,
                ),
            ];
            for with_hooks in [false, true] {
                for offset in (0..300).step_by(50).map(Duration::from_millis) {
                    let start = Instant::now();
                    let mut agent = claude(start);
                    let mut events = hooks.iter().filter(|_| with_hooks).peekable();
                    let mut states: Vec<AgentState> = Vec::new();
                    recording.replay(offset, |at, screen| {
                        while let Some((_, event)) = events.next_if(|(t, _)| *t <= at) {
                            agent.apply(report(*event, "s", None), screen.revision, start + at);
                        }
                        agent.scan_screen(&detector, screen, start + at);
                        let state = agent.status.state.clone();
                        if at >= dialog + Duration::from_millis(300) && at < answered {
                            assert_eq!(state, AgentState::Blocked, "{offset:?} {at:?}");
                            // So `osc_title_working`, which outranks every blocker,
                            // cannot hide a dialog.
                            assert!(screen.title.starts_with('✳'), "{:?}", screen.title);
                        }
                        if states.last() != Some(&state) && state != AgentState::Unknown {
                            states.push(state);
                        }
                    });
                    let last = if with_hooks {
                        AgentState::Done
                    } else {
                        AgentState::Idle
                    };
                    // The trust dialog, its prompt, the turn, its dialog, and the end.
                    assert_eq!(
                        states,
                        [
                            AgentState::Blocked,
                            AgentState::Idle,
                            AgentState::Working,
                            AgentState::Blocked,
                            AgentState::Working,
                            last,
                        ],
                        "hooks: {with_hooks}, offset: {offset:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn recorded_agy_turns_settle_idle_and_block_on_approval() {
        let detector = Detector::new(None);
        let recording = Recording::parse(include_str!(
            "detection/fixtures/agy-1.4.10-command-approval.jsonl"
        ));
        let trusted = recording.note("trust: sent");
        let dialog = recording.note("requesting permission for:: hit");
        let answered = recording.note("approve: sent");
        for offset in (0..300).step_by(50).map(Duration::from_millis) {
            let start = Instant::now();
            let process = AgentProcess {
                pid: 10,
                start_time: 5,
            };
            let mut agent = AgentLifecycle::detected(process, "agy".into(), start);
            let mut states: Vec<AgentState> = Vec::new();
            recording.replay(offset, |at, screen| {
                agent.scan_screen(&detector, screen, start + at);
                let state = agent.status.state.clone();
                if at >= dialog + Duration::from_millis(300) && at < answered {
                    assert_eq!(state, AgentState::Blocked, "{offset:?} {at:?}");
                }
                if at > trusted && states.last() != Some(&state) && state != AgentState::Unknown {
                    states.push(state);
                }
            });
            // Two turns, the second with a command approval.
            assert_eq!(
                states,
                [
                    AgentState::Idle,
                    AgentState::Working,
                    AgentState::Idle,
                    AgentState::Working,
                    AgentState::Blocked,
                    AgentState::Working,
                    AgentState::Idle,
                ],
                "offset: {offset:?}"
            );
        }
    }

    fn tool_call(id: &str) -> ToolCall {
        ToolCall {
            id: Some(id.to_string()),
            input: None,
        }
    }

    fn report(event: AgentEvent, session: &str, turn: Option<&str>) -> AgentReport {
        AgentReport {
            event,
            session_id: Some(session.to_string()),
            turn_id: turn.map(str::to_string),
            tool: None,
            process: None,
            agent: None,
            source: Some("hook".to_string()),
            message: None,
        }
    }

    #[test]
    fn compaction_start_preserves_working_turn() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::SessionStart, "s", None), 0, now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        agent.apply(report(AgentEvent::SessionStart, "s", None), 0, now);
        assert_eq!(agent.status.state, AgentState::Working);
    }

    #[test]
    fn a_new_process_resets_a_resumed_session() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        let mut start = report(AgentEvent::SessionStart, "s", None);
        start.process = Some(AgentProcess {
            pid: 42,
            start_time: 7,
        });
        agent.apply(start, 0, now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let mut resume = report(AgentEvent::SessionStart, "s", None);
        resume.process = Some(AgentProcess {
            pid: 43,
            start_time: 8,
        });
        agent.apply(resume, 0, now);
        assert_eq!(agent.status.state, AgentState::Idle);
        assert_eq!(agent.process.unwrap().pid, 43);
    }

    #[test]
    fn late_events_cannot_overwrite_a_new_turn_or_session() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("old")), 0, now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("new")), 0, now);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "s", Some("old")), 0, now),
            None
        );
        assert_eq!(agent.status.state, AgentState::Working);
        let mut unscoped = report(AgentEvent::TurnFinished, "s", None);
        assert_eq!(agent.apply(unscoped, 0, now), None);
        unscoped = report(AgentEvent::TurnFinished, "s", Some("new"));
        unscoped.session_id = None;
        assert_eq!(agent.apply(unscoped, 0, now), None);
        agent.apply(report(AgentEvent::SessionStart, "next", None), 0, now);
        assert_eq!(
            agent.apply(
                report(AgentEvent::PermissionRequest, "s", Some("old")),
                0,
                now
            ),
            None
        );
        assert!(!agent.matches_session(Some("s")));
        assert_eq!(agent.status.state, AgentState::Idle);
    }

    #[test]
    fn repeated_and_late_turn_starts_cannot_revive_a_turn() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        let apply = |agent: &mut AgentLifecycle, event, turn| {
            agent.apply(report(event, "s", Some(turn)), 0, now)
        };
        apply(&mut agent, AgentEvent::TurnStart, "a");
        apply(&mut agent, AgentEvent::PermissionRequest, "a");
        // Claude reuses the turn's prompt_id for input queued into it.
        assert_eq!(apply(&mut agent, AgentEvent::TurnStart, "a"), Some(false));
        assert_eq!(agent.status.state, AgentState::Blocked);
        apply(&mut agent, AgentEvent::TurnFinished, "a");
        assert_eq!(apply(&mut agent, AgentEvent::TurnStart, "a"), None);
        assert_eq!(agent.status.state, AgentState::Done);

        apply(&mut agent, AgentEvent::TurnStart, "b");
        apply(&mut agent, AgentEvent::TurnStart, "c");
        for event in [
            AgentEvent::TurnStart,
            AgentEvent::PermissionRequest,
            AgentEvent::TurnFinished,
        ] {
            assert_eq!(apply(&mut agent, event, "b"), None, "{event:?}");
        }
        assert_eq!(agent.status.state, AgentState::Working);
    }

    #[test]
    fn retired_turns_stay_bounded_and_reset_with_the_session() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        for turn in 0..20 {
            let turn = turn.to_string();
            agent.apply(report(AgentEvent::TurnStart, "s", Some(&turn)), 0, now);
            agent.apply(report(AgentEvent::TurnFinished, "s", Some(&turn)), 0, now);
        }
        assert_eq!(agent.retired_turns.len(), MAX_RETIRED);
        agent.apply(report(AgentEvent::SessionStart, "next", None), 0, now);
        assert!(agent.retired_turns.is_empty());
    }

    #[test]
    fn tool_ids_outrank_matching_inputs() {
        let call = |id: Option<&str>| ToolCall {
            id: id.map(str::to_string),
            input: Some(ToolInput::new(
                "Bash".into(),
                &serde_json::json!({"command": "ls"}),
            )),
        };
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let mut permission = report(AgentEvent::PermissionRequest, "s", Some("t"));
        permission.tool = Some(call(Some("t2")));
        agent.apply(permission, 0, now);
        let mut other = report(AgentEvent::ToolFinished, "s", Some("t"));
        other.tool = Some(call(Some("t1")));
        agent.apply(other, 0, now);
        assert_eq!(agent.status.state, AgentState::Blocked);
        // Without an id on either side, the input pairs them.
        assert!(call(None).matches(&call(Some("t1"))));
        let mut finished = report(AgentEvent::ToolFinished, "s", Some("t"));
        finished.tool = Some(call(Some("t2")));
        agent.apply(finished, 0, now);
        assert_eq!(agent.status.state, AgentState::Working);
    }

    #[test]
    fn tool_inputs_match_when_approval_adds_fields() {
        let input = |name: &str, value| ToolInput::new(name.into(), &value);
        let asked = input("Ask", serde_json::json!({"questions": ["q"]}));
        let answered = input(
            "Ask",
            serde_json::json!({"questions": ["q"], "answers": {"q": "a"}}),
        );
        assert!(asked.covered_by(&answered));
        assert!(!answered.covered_by(&asked));
        assert!(!asked.covered_by(&input("Ask", serde_json::json!({"questions": ["r"]}))));
        assert!(!asked.covered_by(&input("Bash", serde_json::json!({"questions": ["q"]}))));
        // A key's hash includes its name.
        assert!(!asked.covered_by(&input("Ask", serde_json::json!({"answers": ["q"]}))));
    }

    #[test]
    fn completed_tool_resumes_only_the_matching_blocked_turn() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), 0, now);
        let mut permission = report(AgentEvent::PermissionRequest, "s", Some("t"));
        permission.tool = Some(tool_call("approval"));
        agent.apply(permission, 0, now);
        assert_eq!(agent.status.state, AgentState::Blocked);
        assert_eq!(
            agent.apply(report(AgentEvent::ToolFinished, "s", Some("other")), 0, now),
            None
        );
        assert_eq!(agent.status.state, AgentState::Blocked);
        let mut other_tool = report(AgentEvent::ToolFinished, "s", Some("t"));
        other_tool.tool = Some(tool_call("other"));
        agent.apply(other_tool, 0, now);
        assert_eq!(agent.status.state, AgentState::Blocked);
        let mut approved_tool = report(AgentEvent::ToolFinished, "s", Some("t"));
        approved_tool.tool = Some(tool_call("approval"));
        agent.apply(approved_tool, 0, now);
        assert_eq!(agent.status.state, AgentState::Working);
        agent.apply(report(AgentEvent::TurnFinished, "s", Some("t")), 0, now);
        agent.status.state = AgentState::Idle;
        assert_eq!(
            agent.apply(
                report(AgentEvent::PermissionRequest, "s", Some("t")),
                0,
                now
            ),
            None
        );
        assert_eq!(agent.status.state, AgentState::Idle);
    }

    #[test]
    fn process_identity_and_unverified_lease_bound_liveness() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        assert!(
            !agent.is_stale(now + UNVERIFIED_AGENT_TTL - Duration::from_secs(1), |_| {
                false
            })
        );
        assert!(agent.is_stale(now + UNVERIFIED_AGENT_TTL, |_| true));
        let mut start = report(AgentEvent::SessionStart, "s", None);
        start.process = Some(AgentProcess {
            pid: 42,
            start_time: 7,
        });
        agent.apply(start, 0, now);
        assert!(!agent.is_stale(now + UNVERIFIED_AGENT_TTL, |p| p.start_time == 7));
        assert!(agent.is_stale(now, |p| p.start_time == 8));
    }
}
