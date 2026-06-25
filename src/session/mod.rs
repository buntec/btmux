pub mod layout;
pub mod manager;

use serde::{Deserialize, Serialize};
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
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PaneSnapshot {
    pub id: Uuid,
    pub title: Option<String>,
    pub cwd: Option<String>,
}

/// One entry per session for the StatusBar and the session picker.
#[derive(Serialize, Clone)]
pub struct SessionSummary {
    pub id: Uuid,
    pub name: String,
}
