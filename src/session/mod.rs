pub mod agent;
pub mod detection;
pub mod layout;
pub mod manager;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::pty::PtyHandle;
use layout::{Layout, LayoutPreset};

pub struct Session {
    pub id: Uuid,
    pub name: String,
    pub windows: Vec<Window>,
    pub active_window: usize,
    pub prev_window: Option<usize>,
}

pub struct Window {
    pub id: Uuid,
    pub name: String,
    pub panes: Vec<Pane>,
    pub active_pane: usize,
    pub prev_pane: Option<usize>,
    pub layout: Layout,
    pub zoomed_pane: Option<Uuid>,
    /// The preset arrangement last applied via `select-layout`/`next-layout`, if
    /// any. Drives `next-layout`'s cycle position. Transient (not snapshotted):
    /// reset to `None` on restore and cleared by manual splits/kills below.
    pub last_preset: Option<LayoutPreset>,
}

impl Window {
    /// Remove `pane_id` from the layout tree and the pane list.
    ///
    /// `active_pane`/`prev_pane` are *indices* into `panes`, so a naive
    /// `retain` would silently re-point them at the wrong pane whenever an
    /// earlier element is removed (the classic "active pane ≠ highlighted
    /// pane" glitch). We capture the ids they reference first, then re-resolve
    /// the indices after the Vec shifts: the active pane keeps its identity if
    /// it survived, falling back to the clamped neighbour if it was the one
    /// removed; `prev_pane` is cleared if its target is gone.
    ///
    /// May leave `panes` empty — the caller decides whether to drop the window.
    pub fn remove_pane(&mut self, pane_id: Uuid) {
        let active_id = self.panes.get(self.active_pane).map(|p| p.id);
        let prev_id = self.prev_pane.and_then(|i| self.panes.get(i)).map(|p| p.id);

        if let Some(new_layout) = self.layout.remove_pane(pane_id) {
            self.layout = new_layout;
        }
        self.panes.retain(|p| p.id != pane_id);
        if self.panes.is_empty() {
            return;
        }

        self.active_pane = active_id
            .and_then(|id| self.panes.iter().position(|p| p.id == id))
            .unwrap_or_else(|| self.active_pane.min(self.panes.len() - 1));
        self.prev_pane = prev_id.and_then(|id| self.panes.iter().position(|p| p.id == id));
        if self.zoomed_pane == Some(pane_id) {
            self.zoomed_pane = None;
        }
        // The collapsed tree no longer matches the preset, so `next-layout`
        // should start its cycle fresh rather than from a stale position.
        self.last_preset = None;
    }
}

pub struct Pane {
    pub id: Uuid,
    pub pty: PtyHandle,
    /// The most severe notification since the pane was last viewed.
    pub unread: Option<PaneAlert>,
    pub prompt: Arc<PromptLock>,
}

/// Orders automation prompts to a pane.
#[derive(Default)]
pub struct PromptLock {
    /// Keeps a paste with its Enter.
    pub submit: tokio::sync::Mutex<()>,
    /// Shared by unwaited prompts and held exclusively by a waited one, each
    /// until its turn starts, so a waited prompt can't claim another's turn.
    pub turn: Arc<tokio::sync::RwLock<()>>,
}

impl Pane {
    pub fn new(id: Uuid, pty: PtyHandle) -> Self {
        Self {
            id,
            pty,
            unread: None,
            prompt: Arc::default(),
        }
    }

    /// Keeps the more severe of the pending and incoming notifications; ties take the newer.
    pub fn notify(&mut self, alert: PaneAlert) {
        if self
            .unread
            .as_ref()
            .is_none_or(|pending| alert.level.rank() >= pending.level.rank())
        {
            self.unread = Some(alert);
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum NotificationLevel {
    Info,
    Attention,
    Success,
    Error,
}

impl NotificationLevel {
    fn rank(self) -> u8 {
        match self {
            Self::Info => 0,
            Self::Success => 1,
            Self::Attention => 2,
            Self::Error => 3,
        }
    }
}

/// A pane notification nobody has viewed yet.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaneAlert {
    pub level: NotificationLevel,
    pub title: Option<String>,
    pub body: Option<String>,
}

/// Lifecycle states for an agent occupying a pane.
///
/// This intentionally follows Herdr's small semantic vocabulary. Failure and
/// permission details belong in the accompanying message/notification instead
/// of multiplying lifecycle states.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum AgentState {
    Unknown,
    Idle,
    Working,
    Blocked,
    Done,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentStatus {
    pub state: AgentState,
    pub agent: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
}

impl Default for AgentStatus {
    fn default() -> Self {
        Self {
            state: AgentState::Unknown,
            agent: None,
            source: None,
            message: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaneSnapshot {
    pub id: Uuid,
    pub title: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub unread: Option<PaneAlert>,
    #[serde(default)]
    pub git: Option<crate::pane_git::PaneGit>,
}

/// A pane running an agent, as listed to automation.
#[derive(Serialize, Clone)]
pub struct AgentPane {
    pub pane_id: Uuid,
    pub session_id: Uuid,
    pub session_name: String,
    pub window_index: usize,
    pub window_name: String,
    pub cwd: Option<String>,
    pub status: AgentStatus,
}

/// One entry per session for the StatusBar and the session picker.
#[derive(Serialize, Clone)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SessionSummary {
    pub id: Uuid,
    pub name: String,
}

/// One pane with its window and session, for `GET /api/panes` and the tmux-style
/// CLI. Fields are named like tmux format variables.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PaneInfo {
    pub session_id: Uuid,
    pub session_name: String,
    pub window_id: Uuid,
    pub window_index: usize,
    pub window_name: String,
    pub window_active: bool,
    pub window_zoomed_flag: bool,
    pub pane_id: Uuid,
    /// Layout order, as `prefix + q` numbers panes.
    pub pane_index: usize,
    pub pane_active: bool,
    pub pane_current_path: Option<String>,
    pub pane_title: Option<String>,
}
