use std::time::{Duration, Instant};

use super::{AgentState, AgentStatus};

pub const UNVERIFIED_AGENT_TTL: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentProcess {
    pub pid: u32,
    pub start_time: u64,
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
    last_seen: Instant,
    ended: bool,
}

impl AgentLifecycle {
    pub fn explicit(status: AgentStatus, now: Instant) -> Self {
        Self {
            status,
            session_id: None,
            turn_id: None,
            turn_complete: false,
            blocked_tool_id: None,
            process: None,
            last_seen: now,
            ended: false,
        }
    }

    pub fn process(&self) -> Option<AgentProcess> {
        if self.ended {
            None
        } else {
            self.process
        }
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
        if self.ended {
            return false;
        }
        match (self.session_id.as_deref(), session_id) {
            (Some(current), Some(incoming)) => current == incoming,
            (Some(_), None) => false,
            _ => true,
        }
    }

    pub fn end(&mut self, now: Instant) {
        self.status = AgentStatus::default();
        self.turn_id = None;
        self.turn_complete = true;
        self.blocked_tool_id = None;
        self.process = None;
        self.last_seen = now;
        self.ended = true;
    }

    pub fn is_active(&self) -> bool {
        !self.ended && self.status.state != AgentState::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(agent.process().unwrap().pid, 43);
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
