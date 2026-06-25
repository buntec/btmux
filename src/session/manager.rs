use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::{
    layout::{Layout, LayoutPreset},
    Pane, PaneSnapshot, Session, SessionSummary, Window,
};
use crate::config::ClientConfig;
use crate::git::RepoLayout;
use crate::pty::PtyHandle;

pub struct SessionManager {
    pub sessions: Vec<Session>,
    shell: String,
    config: ClientConfig,
    events: broadcast::Sender<String>,
    exit_tx: mpsc::UnboundedSender<Uuid>,
    meta_tx: mpsc::UnboundedSender<()>,
    port: u16,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionSnapshot {
    pub id: Uuid,
    pub name: String,
    pub windows: Vec<WindowSnapshot>,
    pub active_window: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WindowSnapshot {
    pub id: Uuid,
    pub name: String,
    pub panes: Vec<PaneSnapshot>,
    pub active_pane: usize,
    pub layout: Layout,
    pub zoomed_pane: Option<Uuid>,
}

impl SessionManager {
    pub fn new(
        shell: String,
        config: ClientConfig,
        exit_tx: mpsc::UnboundedSender<Uuid>,
        meta_tx: mpsc::UnboundedSender<()>,
        port: u16,
    ) -> Self {
        let (events, _) = broadcast::channel::<String>(64);
        Self {
            sessions: Vec::new(),
            shell,
            config,
            events,
            exit_tx,
            meta_tx,
            port,
        }
    }

    pub fn events(&self) -> &broadcast::Sender<String> {
        &self.events
    }

    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: ClientConfig) {
        self.config = config;
    }

    pub fn set_shell(&mut self, shell: String) {
        self.shell = shell;
    }

    pub async fn create_session(&mut self, name: Option<String>) -> Uuid {
        self.create_session_with_cwd(name, None).await
    }

    pub async fn create_session_with_cwd(
        &mut self,
        name: Option<String>,
        cwd: Option<std::path::PathBuf>,
    ) -> Uuid {
        self.create_session_with_cwd_and_window(name, cwd, None)
            .await
    }

    pub async fn create_session_with_cwd_and_window(
        &mut self,
        name: Option<String>,
        cwd: Option<std::path::PathBuf>,
        window_name: Option<String>,
    ) -> Uuid {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let pty = PtyHandle::new_with_cwd(
            &self.shell,
            pane_id,
            self.exit_tx.clone(),
            self.meta_tx.clone(),
            cwd,
            self.port,
        );

        let pane = Pane { id: pane_id, pty };
        let wname = window_name
            .unwrap_or_else(|| self.unique_window_name_in(&[], &shell_name(&self.shell)));
        let window = Window {
            id: Uuid::new_v4(),
            name: wname,
            panes: vec![pane],
            active_pane: 0,
            prev_pane: None,
            layout: Layout::Leaf { pane_id },
            zoomed_pane: None,
            last_preset: None,
        };

        let base = name.unwrap_or_else(|| self.sessions.len().to_string());
        let sname = self.unique_session_name(&base, None);
        let session = Session {
            id: session_id,
            name: sname,
            windows: vec![window],
            active_window: 0,
            prev_window: None,
        };

        self.sessions.push(session);
        session_id
    }

    pub fn find_pane(&self, pane_id: Uuid) -> Option<&Pane> {
        for session in &self.sessions {
            for window in &session.windows {
                for pane in &window.panes {
                    if pane.id == pane_id {
                        return Some(pane);
                    }
                }
            }
        }
        None
    }

    pub fn find_pane_mut(&mut self, pane_id: Uuid) -> Option<&mut Pane> {
        for session in &mut self.sessions {
            for window in &mut session.windows {
                for pane in &mut window.panes {
                    if pane.id == pane_id {
                        return Some(pane);
                    }
                }
            }
        }
        None
    }

    fn session_mut(&mut self, session_id: Uuid) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == session_id)
    }

    pub async fn split_pane(&mut self, session_id: Uuid, pane_id: Uuid, direction: String) {
        let new_pane_id = Uuid::new_v4();
        // Inherit the source pane's current working directory (tracked via OSC 7),
        // so the new shell starts where the pane it was split from is — but only
        // if that directory still exists.
        let cwd = self
            .find_pane(pane_id)
            .and_then(|p| p.pty.cwd.lock().unwrap().clone())
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_dir());
        let pty = PtyHandle::new_with_cwd(
            &self.shell,
            new_pane_id,
            self.exit_tx.clone(),
            self.meta_tx.clone(),
            cwd,
            self.port,
        );
        let new_pane = Pane {
            id: new_pane_id,
            pty,
        };

        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        window
            .layout
            .find_and_split(pane_id, new_pane_id, &direction);
        window.panes.push(new_pane);
        window.active_pane = window.panes.len() - 1;
        // A manual split breaks the preset arrangement; next-layout cycles fresh.
        window.last_preset = None;
    }

    pub fn kill_pane(&mut self, session_id: Uuid, pane_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];

        if window.panes.len() <= 1 {
            return;
        }

        window.remove_pane(pane_id);
    }

    pub async fn handle_pane_exit(&mut self, pane_id: Uuid) {
        let Some((si, wi)) = self.sessions.iter().enumerate().find_map(|(si, s)| {
            s.windows
                .iter()
                .position(|w| w.panes.iter().any(|p| p.id == pane_id))
                .map(|wi| (si, wi))
        }) else {
            return;
        };

        let window = &mut self.sessions[si].windows[wi];
        window.remove_pane(pane_id);
        if !window.panes.is_empty() {
            return;
        }

        let session = &mut self.sessions[si];
        session.windows.remove(wi);
        if !session.windows.is_empty() {
            if wi < session.active_window {
                session.active_window -= 1;
            } else if session.active_window >= session.windows.len() {
                session.active_window = session.windows.len() - 1;
            }
            return;
        }

        self.sessions.remove(si);
        if self.sessions.is_empty() {
            self.create_session(Some("0".to_string())).await;
        }
    }

    pub fn navigate(&mut self, session_id: Uuid, direction: String) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        let current_pane_id = window.panes[window.active_pane].id;

        if let Some(next_id) = window.layout.navigate_from(current_pane_id, &direction) {
            if let Some(idx) = window.panes.iter().position(|p| p.id == next_id) {
                let prev = window.active_pane;
                if idx != prev {
                    window.prev_pane = Some(prev);
                    window.active_pane = idx;
                }
            }
        }
    }

    pub fn select_pane(&mut self, session_id: Uuid, pane_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        if let Some(idx) = window.panes.iter().position(|p| p.id == pane_id) {
            let prev = window.active_pane;
            if idx != prev {
                window.prev_pane = Some(prev);
                window.active_pane = idx;
            }
        }
    }

    pub fn last_pane(&mut self, session_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        if let Some(prev) = window.prev_pane {
            if prev < window.panes.len() {
                window.prev_pane = Some(window.active_pane);
                window.active_pane = prev;
            }
        }
    }

    /// Cycle active pane forward (+1) or backward (-1) in layout order.
    pub fn cycle_pane(&mut self, session_id: Uuid, delta: i32) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        let ids = window.layout.pane_ids();
        if ids.len() <= 1 {
            return;
        }
        let current_id = window.panes[window.active_pane].id;
        let Some(pos) = ids.iter().position(|id| *id == current_id) else {
            return;
        };
        let next_pos = ((pos as i32 + delta).rem_euclid(ids.len() as i32)) as usize;
        let next_id = ids[next_pos];
        if let Some(idx) = window.panes.iter().position(|p| p.id == next_id) {
            let prev = window.active_pane;
            if idx != prev {
                window.prev_pane = Some(prev);
                window.active_pane = idx;
            }
        }
    }

    /// Swap the active pane with the next (+1) or previous (-1) pane in layout order.
    pub fn swap_pane(&mut self, session_id: Uuid, delta: i32) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        let ids = window.layout.pane_ids();
        if ids.len() <= 1 {
            return;
        }
        let current_id = window.panes[window.active_pane].id;
        let Some(pos) = ids.iter().position(|id| *id == current_id) else {
            return;
        };
        let other_pos = ((pos as i32 + delta).rem_euclid(ids.len() as i32)) as usize;
        let other_id = ids[other_pos];
        window.layout.swap_panes(current_id, other_id);
    }

    /// Re-arrange the active window's panes into a named preset layout
    /// (`even-horizontal`, `even-vertical`, `main-vertical`, `main-horizontal`,
    /// `tiled`). Panes keep their identity and order — only the layout tree is
    /// rebuilt — so PTYs and scrollback are untouched. A zoom is cleared (the
    /// new arrangement supersedes it). Records the preset so `next-layout` can
    /// continue the cycle from here.
    pub fn select_layout(&mut self, session_id: Uuid, preset: LayoutPreset) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        // Preserve the on-screen left-to-right / top-to-bottom order of the
        // current tree so re-laying-out feels stable rather than scrambling panes.
        let ids = window.layout.pane_ids();
        if let Some(layout) = preset.build(&ids) {
            window.layout = layout;
            window.zoomed_pane = None;
            window.last_preset = Some(preset);
        }
    }

    /// Cycle the active window to the next preset layout (tmux `next-layout` /
    /// the Space binding). Starts at `even-horizontal` when no preset has been
    /// applied yet, otherwise advances from the last one.
    pub fn next_layout(&mut self, session_id: Uuid) {
        let next = self
            .session_mut(session_id)
            .map(|s| &s.windows[s.active_window])
            .and_then(|w| w.last_preset)
            .map_or(LayoutPreset::ALL[0], |p| p.next());
        self.select_layout(session_id, next);
    }

    pub async fn create_window(&mut self, session_id: Uuid) {
        self.create_window_named(session_id, None, None).await;
    }

    pub async fn create_window_named(
        &mut self,
        session_id: Uuid,
        name: Option<String>,
        cwd: Option<std::path::PathBuf>,
    ) {
        let pane_id = Uuid::new_v4();
        let pty = PtyHandle::new_with_cwd(
            &self.shell,
            pane_id,
            self.exit_tx.clone(),
            self.meta_tx.clone(),
            cwd,
            self.port,
        );
        let pane = Pane { id: pane_id, pty };
        let base = name.unwrap_or_else(|| shell_name(&self.shell));

        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let existing: Vec<_> = session.windows.iter().map(|w| w.name.as_str()).collect();
        let wname = unique_name_in(&existing, &base);
        let window = Window {
            id: Uuid::new_v4(),
            name: wname,
            panes: vec![pane],
            active_pane: 0,
            prev_pane: None,
            layout: Layout::Leaf { pane_id },
            zoomed_pane: None,
            last_preset: None,
        };
        session.windows.push(window);
        session.active_window = session.windows.len() - 1;
    }

    /// Write a pane's captured scrollback (clean text supplied by the frontend,
    /// read from the ghostty-web buffer) to a temp file, then open it in the
    /// user's editor *inside the captured pane's own shell* by injecting the
    /// command into its PTY input — like `tmux send-keys`. Reusing the live PTY
    /// (and the already-mounted ghostty-web terminal) avoids spinning up a new
    /// pane/terminal just to view the capture.
    ///
    /// The editor is resolved on the backend (`$VISUAL`/`$EDITOR`, else `vi`)
    /// rather than via shell expansion, because the line is fed to whatever shell
    /// the pane runs and `${VISUAL:-…}` isn't portable (e.g. fish). This assumes
    /// the pane is sitting at a shell prompt; if a full-screen app is running the
    /// keystrokes go to that app instead, same caveat as `send-keys`.
    pub fn capture_pane_to_editor(&self, pane_id: Uuid, content: String) {
        let Some(pane) = self.find_pane(pane_id) else {
            return;
        };
        // input_tx only has a live receiver once the shell is spawned; the active
        // pane the user captured always is, but guard so a stray id is a no-op.
        if !pane.pty.is_spawned() {
            return;
        }

        // Unique-ish temp filename: pane id + millis since the epoch.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("btmux-capture-{pane_id}-{stamp}.txt"));
        if let Err(e) = std::fs::write(&path, content.as_bytes()) {
            tracing::warn!("failed to write capture file {}: {}", path.display(), e);
            return;
        }

        let editor = std::env::var("VISUAL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("EDITOR").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "vi".to_string());

        // Leading space keeps it out of history in shells honouring that (bash
        // HISTCONTROL, zsh HIST_IGNORE_SPACE, fish); trailing CR submits the line
        // — `\r` is the exact byte the Enter key sends (ghostty-web's onData emits
        // it), so an interactive shell's line editor treats it as "run this".
        let line = format!(
            " {editor} {}\r",
            shell_single_quote(&path.to_string_lossy())
        );
        let _ = pane.pty.input_tx.send(line.into_bytes());
    }

    pub fn switch_window(&mut self, session_id: Uuid, index: i32) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let len = session.windows.len();
        let prev = session.active_window;
        let next = resolve_index(prev, len, index);
        if next != prev {
            session.prev_window = Some(prev);
            session.active_window = next;
        }
    }

    pub fn last_window(&mut self, session_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        if let Some(prev) = session.prev_window {
            if prev < session.windows.len() {
                session.prev_window = Some(session.active_window);
                session.active_window = prev;
            }
        }
    }

    pub fn rename_window(&mut self, session_id: Uuid, name: String) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let active = session.active_window;
        let existing: Vec<_> = session
            .windows
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != active)
            .map(|(_, w)| w.name.as_str())
            .collect();
        let unique = unique_name_in(&existing, &name);
        session.windows[active].name = unique;
    }

    pub fn close_window(&mut self, session_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        if session.windows.len() <= 1 {
            return;
        }
        session.windows.remove(session.active_window);
        if session.active_window >= session.windows.len() {
            session.active_window = session.windows.len() - 1;
        }
    }

    pub fn zoom_pane(&mut self, session_id: Uuid, pane_id: Uuid) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        if window.zoomed_pane == Some(pane_id) {
            window.zoomed_pane = None;
        } else {
            window.zoomed_pane = Some(pane_id);
        }
    }

    pub fn rename_session(&mut self, session_id: Uuid, name: String) {
        let unique = self.unique_session_name(&name, Some(session_id));
        if let Some(session) = self.session_mut(session_id) {
            session.name = unique;
        }
    }

    pub fn resize_split(&mut self, session_id: Uuid, split_id: Uuid, ratio: f32) {
        let Some(session) = self.session_mut(session_id) else {
            return;
        };
        let window = &mut session.windows[session.active_window];
        window.layout.update_split_ratio(split_id, ratio);
    }

    pub fn kill_session(&mut self, id: Uuid) {
        if self.sessions.len() <= 1 {
            return;
        }
        if let Some(idx) = self.sessions.iter().position(|s| s.id == id) {
            self.sessions.remove(idx);
        }
    }

    /// Kill every session and start over with a single fresh default session.
    /// Dropping the `Session` values drops their `PtyHandle`s, which tears down
    /// the shells. The "always ≥1 session" invariant is preserved (mirrors
    /// `kill_session` refusing to remove the last one and `handle_pane_exit`
    /// recreating "0" when the tree empties), so this resets rather than empties.
    pub async fn clear_sessions(&mut self) {
        self.sessions.clear();
        self.create_session(Some("0".to_string())).await;
    }

    /// Best-known working directory of a session's active pane (OSC-7 cwd, with
    /// spawn-cwd fallback). Used as the base directory for the
    /// `create-sessions-from-git-repos` command palette entry.
    pub fn active_pane_cwd(&self, session_id: Uuid) -> Option<std::path::PathBuf> {
        let session = self.sessions.iter().find(|s| s.id == session_id)?;
        let window = session.windows.get(session.active_window)?;
        let pane = window.panes.get(window.active_pane)?;
        pane.pty.effective_cwd().map(std::path::PathBuf::from)
    }

    /// Create one session per git repo in `layouts` (produced by
    /// `git::discover_repo_layouts`, which does the blocking filesystem/`git`
    /// work off the lock). Each repo becomes a session named after its directory,
    /// with one window per worktree branch (the first worktree is the initial
    /// window, the rest are added windows). Repos whose sanitized name already
    /// matches an existing session are skipped, so re-running is idempotent.
    pub async fn create_sessions_from_git_repos(&mut self, layouts: Vec<RepoLayout>) {
        for layout in layouts {
            if self.sessions.iter().any(|s| s.name == layout.name) {
                tracing::info!("session '{}' already exists, skipping", layout.name);
                continue;
            }

            // First worktree (if any) is the session's initial window; the rest
            // become extra windows. With no named worktrees, fall back to a
            // single window at the repo root.
            let (first_window_name, first_window_cwd, extra) = match layout.windows.split_first() {
                Some(((name, path), rest)) => (Some(name.clone()), path.clone(), rest),
                None => (None, layout.root.clone(), &[][..]),
            };

            let session_id = self
                .create_session_with_cwd_and_window(
                    Some(layout.name.clone()),
                    Some(first_window_cwd),
                    first_window_name,
                )
                .await;
            tracing::info!("created session '{}' ({})", layout.name, session_id);

            for (branch, path) in extra {
                self.create_window_named(session_id, Some(branch.clone()), Some(path.clone()))
                    .await;
            }
        }
    }

    pub fn kill_window(&mut self, window_id: Uuid) {
        for session in &mut self.sessions {
            if let Some(wi) = session.windows.iter().position(|w| w.id == window_id) {
                if session.windows.len() <= 1 {
                    return;
                }
                session.windows.remove(wi);
                if session.active_window >= session.windows.len() {
                    session.active_window = session.windows.len() - 1;
                }
                return;
            }
        }
    }

    pub fn session_summaries(&self) -> Vec<SessionSummary> {
        self.sessions
            .iter()
            .map(|s| SessionSummary {
                id: s.id,
                name: s.name.clone(),
            })
            .collect()
    }

    pub fn all_snapshots(&self) -> Vec<SessionSnapshot> {
        self.sessions
            .iter()
            .map(|s| self.session_snapshot(s))
            .collect()
    }

    /// Rebuild the session tree from saved snapshots. Process state is *not*
    /// restored — each pane gets a fresh shell, spawned lazily on first
    /// `/ws/pane` connection in its saved cwd (if that directory still exists).
    /// Pane and window/session ids are preserved so the saved layout tree still
    /// resolves and any open tab's URL still points at a live session.
    ///
    /// Snapshots that are structurally empty (a window with no panes, or a
    /// session with no windows) are dropped. Returns the number of sessions
    /// actually restored, so the caller can fall back to a default session when
    /// nothing usable survived.
    pub fn restore_from_snapshots(&mut self, snapshots: Vec<SessionSnapshot>) -> usize {
        let shell = self.shell.clone();
        self.sessions = snapshots
            .into_iter()
            .filter_map(|s| self.build_session(&shell, s))
            .collect();
        self.sessions.len()
    }

    fn build_session(&self, shell: &str, snap: SessionSnapshot) -> Option<Session> {
        let windows: Vec<Window> = snap
            .windows
            .into_iter()
            .filter_map(|w| self.build_window(shell, w))
            .collect();
        if windows.is_empty() {
            return None;
        }
        let active_window = snap.active_window.min(windows.len() - 1);
        Some(Session {
            id: snap.id,
            name: snap.name,
            windows,
            active_window,
            prev_window: None,
        })
    }

    fn build_window(&self, shell: &str, snap: WindowSnapshot) -> Option<Window> {
        let panes: Vec<Pane> = snap
            .panes
            .into_iter()
            .map(|p| {
                // Re-spawn into the saved cwd only if it still exists.
                let cwd = p
                    .cwd
                    .as_deref()
                    .map(std::path::PathBuf::from)
                    .filter(|path| path.is_dir());
                let pty = PtyHandle::new_with_cwd(
                    shell,
                    p.id,
                    self.exit_tx.clone(),
                    self.meta_tx.clone(),
                    cwd,
                    self.port,
                );
                Pane { id: p.id, pty }
            })
            .collect();
        if panes.is_empty() {
            return None;
        }
        let active_pane = snap.active_pane.min(panes.len() - 1);
        // Drop a stale zoom that points at a pane that's no longer present.
        let zoomed_pane = snap
            .zoomed_pane
            .filter(|z| panes.iter().any(|p| p.id == *z));
        Some(Window {
            id: snap.id,
            name: snap.name,
            panes,
            active_pane,
            prev_pane: None,
            layout: snap.layout,
            zoomed_pane,
            // Transient: the cycle starts fresh after a restore.
            last_preset: None,
        })
    }

    pub fn snapshot_by_id(&self, session_id: Uuid) -> Option<SessionSnapshot> {
        self.sessions
            .iter()
            .find(|s| s.id == session_id)
            .map(|s| self.session_snapshot(s))
    }

    fn session_snapshot(&self, session: &super::Session) -> SessionSnapshot {
        SessionSnapshot {
            id: session.id,
            name: session.name.clone(),
            windows: session
                .windows
                .iter()
                .map(|w| WindowSnapshot {
                    id: w.id,
                    name: w.name.clone(),
                    panes: w
                        .panes
                        .iter()
                        .map(|p| PaneSnapshot {
                            id: p.id,
                            title: p.pty.title.lock().unwrap().clone(),
                            cwd: p.pty.effective_cwd(),
                        })
                        .collect(),
                    active_pane: w.active_pane,
                    layout: w.layout.clone(),
                    zoomed_pane: w.zoomed_pane,
                })
                .collect(),
            active_window: session.active_window,
        }
    }
}

impl SessionManager {
    fn unique_session_name(&self, base: &str, exclude_id: Option<Uuid>) -> String {
        let existing: Vec<_> = self
            .sessions
            .iter()
            .filter(|s| Some(s.id) != exclude_id)
            .map(|s| s.name.as_str())
            .collect();
        unique_name_in(&existing, base)
    }

    fn unique_window_name_in(&self, existing: &[&str], base: &str) -> String {
        unique_name_in(existing, base)
    }
}

fn unique_name_in(existing: &[&str], base: &str) -> String {
    if !existing.contains(&base) {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{}-{}", base, n);
        if !existing.contains(&candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// POSIX single-quote a string for safe interpolation into a shell command line:
/// wrap in `'…'` and replace each embedded `'` with `'\''`. Works for bash, zsh,
/// and fish alike (all treat single quotes literally). Used to inject the capture
/// file path into a pane's shell.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn shell_name(shell: &str) -> String {
    std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_string()
}

fn resolve_index(current: usize, len: usize, index: i32) -> usize {
    if len == 0 {
        return current;
    }
    match index {
        -1 => (current + 1) % len,
        -2 => {
            if current == 0 {
                len - 1
            } else {
                current - 1
            }
        }
        i if i >= 0 && (i as usize) < len => i as usize,
        _ => current,
    }
}
