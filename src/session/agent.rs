use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::detection::{Detection, DetectionInput, Detector};
use super::{AgentState, AgentStatus};
use crate::pty::screen::ScreenSnapshot;

pub const UNVERIFIED_AGENT_TTL: Duration = Duration::from_secs(12 * 60 * 60);

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
    pub tool_use_id: Option<String>,
    pub process: Option<AgentProcess>,
    pub agent: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
}

pub struct AgentLifecycle {
    pub status: AgentStatus,
    session_id: Option<String>,
    turn_id: Option<String>,
    turn_complete: bool,
    blocked_tool_id: Option<String>,
    process: Option<AgentProcess>,
    observed_process: bool,
    last_seen: Instant,
    ended: bool,
    ended_process: Option<AgentProcess>,
    retired_sessions: Vec<String>,
    pub detection: Option<Detection>,
    screen_revision: Option<u64>,
    signal_floor: u64,
    screen_floor: Option<u64>,
    pending_screen: Option<(AgentState, Instant)>,
}

impl AgentLifecycle {
    pub fn detected(process: AgentProcess, name: String, now: Instant) -> Self {
        let mut lifecycle = Self::explicit(
            AgentStatus {
                state: AgentState::Unknown,
                agent: Some(name),
                source: Some("process".to_string()),
                message: None,
            },
            now,
        );
        lifecycle.process = Some(process);
        lifecycle.observed_process = true;
        lifecycle
    }

    pub fn explicit(status: AgentStatus, now: Instant) -> Self {
        Self {
            status,
            session_id: None,
            turn_id: None,
            turn_complete: false,
            blocked_tool_id: None,
            process: None,
            observed_process: false,
            last_seen: now,
            ended: false,
            ended_process: None,
            retired_sessions: Vec::new(),
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
    ) -> bool {
        let replaced = self.ended || (self.observed_process && self.process != Some(process));
        let changed_name = self.status.agent.as_deref() != Some(name);
        if replaced {
            let mut retired_sessions = std::mem::take(&mut self.retired_sessions);
            if let Some(session) = self.session_id.take() {
                retired_sessions.push(session);
            }
            if retired_sessions.len() > 8 {
                retired_sessions.remove(0);
            }
            *self = Self::detected(process, name.to_string(), now);
            self.retired_sessions = retired_sessions;
            self.signal_floor = revision;
            self.screen_floor = Some(revision);
        } else {
            self.process = Some(process);
            self.observed_process = true;
            self.status.agent = Some(name.to_string());
        }
        replaced || changed_name
    }

    pub fn process(&self) -> Option<AgentProcess> {
        self.process
    }

    pub fn scan_screen(
        &mut self,
        detector: &Detector,
        screen: &ScreenSnapshot,
        foreground: bool,
        now: Instant,
    ) -> bool {
        if self.ended || !self.observed_process {
            return false;
        }
        if self
            .status
            .source
            .as_deref()
            .is_some_and(|source| !matches!(source, "hook" | "process" | "screen"))
        {
            return false;
        }
        if !foreground {
            self.screen_revision = None;
            self.pending_screen = None;
            self.signal_floor = screen.revision;
            self.screen_floor = Some(screen.revision);
            let previous = self.status.clone();
            self.status.state = AgentState::Unknown;
            self.status.source = Some("process".into());
            self.status.message = None;
            self.detection = None;
            return self.status != previous;
        }
        if self
            .screen_floor
            .is_some_and(|floor| screen.revision <= floor)
        {
            return false;
        }
        if self.screen_revision == Some(screen.revision) && self.pending_screen.is_none() {
            return false;
        }
        self.screen_floor = None;
        self.screen_revision = Some(screen.revision);
        let Some(name) = self.status.agent.as_deref() else {
            return false;
        };
        let Some(mut detection) = detector.detect(
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
        ) else {
            return false;
        };
        detection.screen_revision = screen.revision;
        self.detection = Some(detection.clone());
        if detection.skip_state_update {
            self.pending_screen = None;
            return false;
        }
        if detection.rule.is_none()
            && self.status.source.as_deref() != Some("screen")
            && !matches!(self.status.state, AgentState::Working | AgentState::Blocked)
        {
            self.pending_screen = None;
            return false;
        }
        // Idle screens do not acknowledge an unread hook completion.
        if self.status.state == AgentState::Done && detection.state == AgentState::Idle {
            self.pending_screen = None;
            return false;
        }
        if matches!(detection.state, AgentState::Idle | AgentState::Unknown)
            && matches!(self.status.state, AgentState::Working | AgentState::Blocked)
        {
            let started = match &self.pending_screen {
                Some((state, started)) if *state == detection.state => *started,
                _ => {
                    self.pending_screen = Some((detection.state.clone(), now));
                    return false;
                }
            };
            if now.duration_since(started) < Duration::from_millis(700) {
                return false;
            }
        }
        self.pending_screen = None;
        let previous = self.status.clone();
        self.status.state = detection.state;
        self.status.source = Some("screen".into());
        if self.status != previous {
            self.status.message = None;
        }
        self.status != previous
    }

    pub fn suppress_old_screen(&mut self, revision: u64) {
        self.screen_floor = Some(revision);
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
        self.observed_process && !self.ended
    }

    pub fn is_stale(&self, now: Instant, process_alive: impl Fn(AgentProcess) -> bool) -> bool {
        if self.ended {
            return now.duration_since(self.last_seen) >= UNVERIFIED_AGENT_TTL;
        }
        match self.process {
            Some(process) => !process_alive(process),
            None => now.duration_since(self.last_seen) >= UNVERIFIED_AGENT_TTL,
        }
    }

    /// Returns None for a report belonging to an older session or turn.
    /// Otherwise returns whether the visible status changed.
    pub fn apply(&mut self, report: AgentReport, now: Instant) -> Option<bool> {
        if report
            .session_id
            .as_ref()
            .is_some_and(|session| self.retired_sessions.contains(session))
        {
            let verified_restart = report.event == AgentEvent::SessionStart
                && report.process.is_some()
                && report.process == self.process;
            if !verified_restart {
                return None;
            }
            self.retired_sessions
                .retain(|session| Some(session) != report.session_id.as_ref());
        }
        if self.session_id.is_some() && report.session_id.is_none() {
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
        self.screen_revision = None;
        self.pending_screen = None;
        self.ended = false;
        if different_session || restarted {
            self.status = AgentStatus::default();
            self.process = report.process;
            self.turn_id = None;
            self.turn_complete = false;
            self.blocked_tool_id = None;
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
        }
        if let Some(source) = report.source {
            self.status.source = Some(source);
        }

        match report.event {
            AgentEvent::SessionStart
                if different_session || restarted || previous.state == AgentState::Unknown =>
            {
                self.status.state = AgentState::Idle;
                self.status.message = None;
            }
            AgentEvent::SessionStart => {}
            AgentEvent::TurnStart => {
                self.turn_id = report.turn_id;
                self.turn_complete = false;
                self.blocked_tool_id = None;
                self.status.state = AgentState::Working;
                self.status.message = None;
            }
            AgentEvent::PermissionRequest => {
                self.blocked_tool_id = report.tool_use_id;
                self.status.state = AgentState::Blocked;
                self.status.message = report.message;
            }
            AgentEvent::ToolFinished => {
                let matches_tool =
                    self.blocked_tool_id.is_none() || self.blocked_tool_id == report.tool_use_id;
                if self.status.state == AgentState::Blocked && matches_tool {
                    self.status.state = AgentState::Working;
                    self.status.message = None;
                    self.blocked_tool_id = None;
                }
            }
            AgentEvent::TurnFinished => {
                self.turn_complete = true;
                self.blocked_tool_id = None;
                self.status.state = AgentState::Done;
                self.status.message = report.message;
            }
            AgentEvent::Interrupt => {
                self.turn_complete = true;
                self.blocked_tool_id = None;
                self.status.state = AgentState::Idle;
                self.status.message = None;
            }
            AgentEvent::SessionEnd => unreachable!("session end is handled by the manager"),
        }
        Some(self.status != previous)
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
        self.ended_process = self.process;
        self.status = AgentStatus::default();
        self.turn_id = None;
        self.turn_complete = true;
        self.blocked_tool_id = None;
        self.process = None;
        self.observed_process = false;
        self.last_seen = now;
        self.ended = true;
        self.detection = None;
        self.pending_screen = None;
    }

    pub fn is_active(&self) -> bool {
        !self.ended && (self.process.is_some() || self.status.state != AgentState::Unknown)
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
        assert!(agent.scan_screen(&detector, &screen("", "⠋ Claude", 1), true, now));
        assert_eq!(agent.status.state, AgentState::Working);
        let idle = screen("──────\n❯\n──────", "", 2);
        assert!(!agent.scan_screen(&detector, &idle, true, now));
        assert!(!agent.scan_screen(&detector, &idle, true, now + Duration::from_millis(300)));
        assert!(agent.scan_screen(&detector, &idle, true, now + Duration::from_millis(700)));
        assert_eq!(agent.status.state, AgentState::Idle);
        agent.apply(report(AgentEvent::TurnStart, "s", None), now);
        agent.apply(report(AgentEvent::TurnFinished, "s", None), now);
        assert!(!agent.scan_screen(&detector, &screen(&idle.text, "", 3), true, now));
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
        agent.apply(report(AgentEvent::TurnStart, "old", None), now);
        let working = screen("", "⠋ Codex", 3);
        agent.suppress_old_screen(3);
        assert!(!agent.scan_screen(&detector, &working, true, now));
        assert!(agent.observe_process(
            AgentProcess {
                pid: 2,
                start_time: 2
            },
            "codex",
            3,
            now
        ));
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert!(!agent.scan_screen(&detector, &working, true, now));
        let new_screen = ScreenSnapshot {
            revision: 4,
            ..working
        };
        assert!(!agent.scan_screen(&detector, &new_screen, true, now));
        assert_eq!(agent.status.state, AgentState::Unknown);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "old", None), now),
            None
        );
        agent.apply(report(AgentEvent::TurnStart, "new", None), now);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "old", None), now),
            None
        );
    }

    fn report(event: AgentEvent, session: &str, turn: Option<&str>) -> AgentReport {
        AgentReport {
            event,
            session_id: Some(session.to_string()),
            turn_id: turn.map(str::to_string),
            tool_use_id: None,
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
        agent.apply(report(AgentEvent::SessionStart, "s", None), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), now);
        agent.apply(report(AgentEvent::SessionStart, "s", None), now);
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
        agent.apply(start, now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), now);
        let mut resume = report(AgentEvent::SessionStart, "s", None);
        resume.process = Some(AgentProcess {
            pid: 43,
            start_time: 8,
        });
        agent.apply(resume, now);
        assert_eq!(agent.status.state, AgentState::Idle);
        assert_eq!(agent.process.unwrap().pid, 43);
    }

    #[test]
    fn late_events_cannot_overwrite_a_new_turn_or_session() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("old")), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("new")), now);
        assert_eq!(
            agent.apply(report(AgentEvent::TurnFinished, "s", Some("old")), now),
            None
        );
        assert_eq!(agent.status.state, AgentState::Working);
        let mut unscoped = report(AgentEvent::TurnFinished, "s", None);
        assert_eq!(agent.apply(unscoped, now), None);
        unscoped = report(AgentEvent::TurnFinished, "s", Some("new"));
        unscoped.session_id = None;
        assert_eq!(agent.apply(unscoped, now), None);
        agent.apply(report(AgentEvent::SessionStart, "next", None), now);
        assert_eq!(
            agent.apply(report(AgentEvent::PermissionRequest, "s", Some("old")), now),
            None
        );
        assert!(!agent.matches_session(Some("s")));
        assert_eq!(agent.status.state, AgentState::Idle);
    }

    #[test]
    fn completed_tool_resumes_only_the_matching_blocked_turn() {
        let now = Instant::now();
        let mut agent = AgentLifecycle::explicit(AgentStatus::default(), now);
        agent.apply(report(AgentEvent::TurnStart, "s", Some("t")), now);
        let mut permission = report(AgentEvent::PermissionRequest, "s", Some("t"));
        permission.tool_use_id = Some("approval".to_string());
        agent.apply(permission, now);
        assert_eq!(agent.status.state, AgentState::Blocked);
        assert_eq!(
            agent.apply(report(AgentEvent::ToolFinished, "s", Some("other")), now),
            None
        );
        assert_eq!(agent.status.state, AgentState::Blocked);
        let mut other_tool = report(AgentEvent::ToolFinished, "s", Some("t"));
        other_tool.tool_use_id = Some("other".to_string());
        agent.apply(other_tool, now);
        assert_eq!(agent.status.state, AgentState::Blocked);
        let mut approved_tool = report(AgentEvent::ToolFinished, "s", Some("t"));
        approved_tool.tool_use_id = Some("approval".to_string());
        agent.apply(approved_tool, now);
        assert_eq!(agent.status.state, AgentState::Working);
        agent.apply(report(AgentEvent::TurnFinished, "s", Some("t")), now);
        agent.status.state = AgentState::Idle;
        assert_eq!(
            agent.apply(report(AgentEvent::PermissionRequest, "s", Some("t")), now),
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
        agent.apply(start, now);
        assert!(!agent.is_stale(now + UNVERIFIED_AGENT_TTL, |p| p.start_time == 7));
        assert!(agent.is_stale(now, |p| p.start_time == 8));
    }
}
