# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## What this is

btmux is a browser-based tmux. A Rust/axum backend owns real PTYs and the
session/window/pane tree; a React + TypeScript frontend renders panes with
wterm (`@wterm/dom`, a DOM renderer) on libghostty compiled to WASM
(`@wterm/ghostty`). The same authenticated server also
provides a file/Git browser, REST API, and MCP server for automation.

## Commands

The `justfile` is the source of truth (`just` lists all recipes). Common ones:

- `just dev` — run backend (port 8044) and frontend (Vite, port 5173) together. **Develop against http://localhost:5173**; Vite proxies `/ws`, `/api`, and `/wallpaper` to 8044. Development uses `--profile dev` to isolate saved sessions and access credentials. The dev backend uses 8044 (not the production default 8004) so it doesn't collide with a running production/service instance; the port lives in the `dev_port` justfile var and is mirrored in `vite.config.ts`.
- `just dev-backend` / `just dev-frontend` — run one side only.
- `just setup` — install frontend dependencies and fetch Rust dependencies.
- `just check` — `cargo check` + `tsc --noEmit` (fast, run this before claiming a change compiles).
- `just lint` — `cargo clippy -- -D warnings` (warnings are errors).
- `just build` — production build: frontend → `frontend/dist`, then `cargo build --release`.
- `just run` — release binary serving the built frontend.
- `just install` — production build + `cargo install --path .`
- `just vm <cmd>` — Ubuntu VM via Multipass (`scripts/vm.sh`, `scripts/vm-cloud-init.yaml`) for Linux testing and clean demos. `up` creates it; `deploy` builds this working tree in the VM, `release [TAG]` installs a release binary, and both (re)start btmux as a systemd user service on `0.0.0.0:8004` (in-place `btmux upgrade` when running); `info` prints the host-reachable URL and token; `desktop-demo` records the desktop app demos with the server in it; `shell`, `stop`, `delete`.
- `just fmt` (alias `just format`) — format the whole codebase (`cargo fmt` + prettier). **Always run this before committing.**

`just test` runs the Rust regression suite. `just protocol` regenerates the frontend
wire types; the tests reject stale generated types. `just check` and `just lint`
remain required compilation/lint checks. `just test-browser` runs
`frontend/reliability-test.ts`, which exercises authentication, origin rejection,
reconnect/replay, config updates, correlated command errors, and multiple viewers,
followed by upgrade, Astryx interaction, theme, Git, and mobile (WebKit) checks
(`just test-nvim-browser` covers the Neovim surface, `just test-fish-browser` the fish integration; `just test-shader-browser`,
run on demand, the shader wallpapers). `frontend/browser-test-stack.ts`
gives each file a fresh stack (debug backend and Vite on free ports, a random token,
`/bin/sh`, temporary XDG and Git config), so a running `just dev`, user config, and
repo state don't affect it; failures keep the stack logs. Stacks put a fake
`multipass` (`frontend/test-bin`) first on the server's `PATH`, logging its calls
to the stack's `multipass` dir (`sandbox-browser-test.ts`), so no test starts a VM. Async page predicates must
use `waitForAsync` (`browser-test-utils.ts`): `page.waitForFunction` treats a
returned Promise as truthy and doesn't wait.
`just test-browser-surface`, also on demand, covers the browser surface and needs Chrome or Chromium.
`just test-frontend` runs the frontend unit tests (`bun test`, the LaTeX detector and theme mapping).

The CLI also accepts `--host`, `--port`, `--profile`, `--shell`, `--public-url`,
`--tailscale`, and `--no-browser`; `install`, `uninstall`, and `restart` manage a per-user
launchd/systemd service.

## Style guide

Keep code comments and git commit messages extremely concise.
Use American English consistently.
This repository is public: never put agent session links (e.g. a `Claude-Session:`
trailer or `claude.ai/code/session_…` URL) in commit messages or PR descriptions.

## Compatibility

There are no backward compatibility guarantees before 0.1.0. Rename or remove
config fields, key actions, saved state, and wire or API types freely, without
aliases or migrations.

## Architecture

### Server-authoritative state

All session structure lives on the backend in `SessionManager`, held as
`Arc<RwLock<SessionManager>>` (aliased `AppState` in `main.rs`). The frontend
holds **no canonical session state** — it renders whatever the server pushes;
its Zustand store also contains local UI state, terminal instances, URL helpers,
and notifications. A fresh profile starts with one default session ("0"); a
saved profile restores its session/window/pane tree and pane working directories.
Window and pane selection is shared server state. The session currently shown is
derived from each browser tab's URL, so session navigation is per-tab.

### WebSocket channels

1. **`/ws/control`** (`src/ws/control.rs`) — JSON command channel for structural changes (pane split/kill/navigate/zoom, pane selection/cycling/swapping, layout changes, window create/switch/rename/close, session create/rename/kill, pane capture/input, and config overrides). Each command mutates `SessionManager` and the server **broadcasts** the result. The client does not own canonical layout; divider dragging may use an ephemeral local ratio until the committed `resize_split` push arrives. Auto-reconnects every 2s (`useControlSocket.ts`).

   **Broadcast fan-out:** `SessionManager` owns a `tokio::sync::broadcast::Sender<String>` (`events()`) carrying pre-serialized `ServerMessage` JSON. Every control socket subscribes to that stream, so a mutation in one browser tab, a REST/MCP call, a config reload, or an agent notification reaches _all_ tabs. On connect a socket is also sent its current `Config` + `State` directly so it doesn't wait for the next event. `ServerMessage` includes `State { sessions, all_sessions }` (`Vec<SessionSummary>` for the StatusBar/picker + `Vec<SessionSnapshot>` with full window/layout data), `Config`, `Toast`, pane notification/clear messages, and per-request `CommandResult` replies. `request_id` command results go only to the originating socket.

2. **`/ws/pane/{pane_id}?cols=&rows=`** (`src/ws/pane_io.rs`) — one socket **per visible pane**, carrying raw terminal bytes. Binary frames = PTY I/O; a JSON text frame `{type:"resize",cols,rows}` reports the viewer's size and `{type:"claim"}` makes it the size owner; other text frames are ignored. The server sends `{type:"owner",owner}` before the replay and whenever ownership changes. On connect, a checkpoint and journal are replayed, followed by `ready`. The browser accepts input only after this initial replay completes.

   `?mirror=1` creates a read-only attachment for window-grid and agent view thumbnails. Mirrors receive output and ordered size frames but never resize or write to the PTY. A `{type:"current_size",cols,rows}` frame precedes the replay, whose `size` frames walk the pane's resize history; the agent view lays out tiles from that frame and `size` frames after `ready`.

3. **`/ws/files`** (`src/ws/files.rs`) — correlated JSON request/response messages for the file browser. It supports directory/file metadata, tree and content search, rich previews, Git status/diff/stage/unstage/discard, rename, copy, move, trash, and delete. Commit and file diffs (`git_commit_diff`, `git_diff`) cap the lines and bytes they send, commit diffs also the files, with exact totals; `DiffRows` draws row chunks as they near the viewport. Opening a binary file (NUL or invalid UTF-8 in its first 8 KiB) runs `open`/`xdg-open` on the server host (`open_if_binary`) instead of the editor. `prefix + f` opens file mode; `prefix + g` opens Git mode. Git mode's magit-style popups (`b` branch, `f` fetch, `F` pull, `P` push, `z` stash, `%` worktree) send `git_refs`/`git_run`; `file_git_ops.rs` maps a structured op to `git` CLI arguments (so credentials and hooks apply) and rejects option-like values. The worktree popup lists `git_refs`' worktrees and sends `git_worktree` (`worktree::Op`: add, open, remove, lock, unlock, prune), which reaches the `SessionManager` through `FilesState` to open windows and close panes as `prefix + W`/`X` do; visiting a worktree with panes navigates to one instead. Keep filesystem access behind the authenticated route and preserve path validation in `fs_ops.rs`. HTML previews load in an iframe from `/api/preview/<path>`, a path URL so relative assets resolve; `v` shows the source instead. They keep the app's origin so assets get the auth cookie, which is safe only because the iframe's `sandbox` and the route's CSP allow no scripts, forms, `<a ping>`, or requests to other origins. Preview keys are replayed to the file browser, as in `VscodeSurface`; WebKit runs no listeners on a sandboxed document, so there the frame gives up focus instead, as it does everywhere when a nested frame takes it. The UTF-8 charset header is decided from the file's first 1 MiB.

4. **`/ws/sysstat`** (`src/ws/sysstat.rs`) — emits one JSON frame per second with per-core CPU, memory, and aggregate network rates for the StatusBar. The frontend reconnects this auxiliary socket independently.

5. **`/ws/nvim`** (`src/ws/nvim.rs`) — a byte proxy between the browser and a new connection to the shared built-in Neovim's RPC socket. The browser speaks msgpack-RPC itself; see *Built-in Neovim* below.

6. **`/ws/browser`** (`src/browser.rs`) — the shared server-side Chromium: JPEG frames as binary messages and page state as JSON, with input and navigation coming back as JSON. See *Browser surface* below.

REST handlers and MCP tools share the same `SessionManager`; structural mutations must call `broadcast_state` so browser tabs stay synchronized. REST lives under `/api` and includes session/window/pane/layout operations, pane input/output, notifications, and raw local-file serving. `GET /api/system` (`system_info.rs`) reports the server host fastfetch-style (`sysinfo`, plus `ioreg` for the Mac model name and the shell's `--version`) for the About dialog's System tab and the `system_info` MCP tool, which adds what the browser reports about its own machine (`lib/clientInfo.ts`). `GET /api/health` (`health.rs`) finds the optional programs btmux uses and runs each one's version command in its own process group (a job on Windows), killed whole on timeout or cancellation since wrappers wait on children, for the About dialog's Health tab, which adds what the browser supports. MCP is mounted at `/mcp`, with rmcp's own Host check off in favor of `auth.rs`; tools cover session/window/pane lifecycle, `send_keys` (text plus tmux-style key names), `read_pane_output` (the rendered screen or scrollback), `run_command`, `system_info`, and agents (`list_agents`, `wait_for_agent`, `send_prompt`). `automation.rs` implements the pane and agent operations that REST, MCP, and the `btmux agents`/`wait` commands share; waits recheck agent status on each state broadcast. `run_command` appends Enter, captures ANSI-stripped output until 400 ms of quiet by default, and has a 15 s default timeout; quiet output does not prove process exit.

### Agent telemetry

`telemetry.rs` receives OTLP/HTTP at `/api/panes/{id}/telemetry/v1/{logs,metrics}` (JSON or protobuf, optional gzip), behind `auth.rs`, and keeps per-minute numeric usage per agent and model (agents run helpers on other models; `model` is `None` for usage reported without one, like Claude's tool calls) for 24 hours in `SessionManager`. Raw log content is discarded. Closed panes keep their usage, so totals don't shrink, and the last 1024 closed can still take an agent's last export, even its first. The store is in the handoff file, so upgrades keep it; restarts clear it. Tabs get all of it as `ServerMessage::AgentTelemetry` with `replace` on connect or lag, then only changed minutes, whole values they merge by timestamp (`mergeTelemetry`), since resending a day of history on every export is too much traffic. `GET /api/telemetry` returns it too; `AgentUsageView.tsx` graphs running totals per model in agent view's Usage tab, in 5-minute points at the 8- and 24-hour ranges. Models keep a color by first use (`modelSlots`), so filtering never repaints one; past the five slots they fold into "Other" in charts, never in the By model table. `chartColor` in `lib/astryx-theme.ts` sets those colors' lightness and chroma from the terminal palette's hues, in an order and at shades checked for colorblind separation. Claude tokens and cost come from metrics, and its requests and tool calls from logs, so nothing counts twice; Codex uses only logs. Metrics must be delta, which `btmux claude` requests; cumulative points are ignored with a warning, since they would need per-series state. Delta points and log records are deduplicated individually through `seen`, so late retries count once. `agent_launch.rs` implements `btmux claude`/`codex`, which set exporter settings for one invocation from the pane's `BTMUX_OTEL_ENDPOINT` and exec the agent, with Codex's credential in `OTEL_EXPORTER_OTLP_LOGS_HEADERS` because it doesn't expand `${VAR}` in a `-c` header (on Windows, they spawn it, looking for `.exe`, `.cmd`, and `.bat` on `PATH`).

### Widgets from the shell

`widget.rs` implements `btmux pick` (stdin's lines become a menu; the choice goes to
stdout, with flags named after fzf's), `confirm`, and `input`, whose text goes to
stdout. `matches_query`, for `--select-1` and `--exit-0`, mirrors `filterPick`.
`fzf.rs` implements `btmux fzf`, also run when linked as `fzf`: arguments it knows map
to the same menu or are dropped; any other runs the real fzf, the first on `PATH`
that isn't this binary, as does a failed menu, which passes on the stdin it read, and
a query with `--select-1` or `--exit-0`, which only fzf's matching can decide.
Marked items print in the order marked, as in fzf; `btmux pick` prints input order.
Only add to its lists what doesn't change the result a caller gets. `POST
/api/panes/{id}/widget` stays open until the user answers; dropping it (the CLI
died) closes the widget. `ServerMessage::Widgets` lists open widgets by id and kind
on every change and on connect, and tabs showing the pane fetch the request (`GET
/api/widgets/{id}`), so long lists aren't broadcast. A tab reports `widget_shown`;
with no report in 3 s the request fails with 409, which the CLI turns into exit
status 2 for callers to fall back on. After that it waits through reloads and window
switches, with no timeout. The first `widget_answer` of the right kind wins.
`usePaneWidget` anchors the card at `PaneTerminal.cursorRect()` and keeps its first
size, so filtering never moves the input. While it is open,
`PaneTerminal.setFocusTarget` sends the pane's focus and keys to the widget, so the
focus rules in `TerminalPane` still apply. Shells have no UI protocol like Neovim's
`ext_popupmenu`, so menus replace the shell's own: when `btmux_pick_menus` is 1,
`extras/fish/btmux.fish` binds Tab and Ctrl-R and wraps `cdh`, each falling back to
fish's own when the pick fails. Tab also leaves fish to complete when its menu is
open or with at most one candidate, and redo keeps Ctrl-R in vi and hybrid normal
mode, also named `default`, found from fish's preset. It checks at the first prompt,
as conf.d runs before config.fish, so it changes nothing when off.

### Plan limits

`agent_limits.rs` serves `GET /api/agent-limits`: the session, weekly, and per-model subscription limits above agent view's Usage tab (`AgentLimitsPanel.tsx`). It starts each CLI and asks without a prompt, so the CLI does its own auth and btmux never reads a credential: Claude's undocumented `get_usage` control request (`claude -p --safe-mode`; `--safe-mode` skips hooks, MCP, and plugins, while `--bare` skips OAuth too) and Codex's experimental `account/rateLimits/read` (`codex app-server`). Only an open Usage tab in a visible browser tab polls (`useAgentLimits`), each read is shared for 50 s, and a failed one keeps the last limits for 10 minutes, with their age shown. A service's `PATH` lacks what shell startup adds, like `~/.local/bin`, so a CLI missing from it runs with the `PATH` of the pane shell, asked for without a terminal (again every 10 minutes while a CLI stays missing). The Health tab finds and runs them the same way. API keys and no login mean no limits, so that agent isn't shown; so does a CLI too old or changed to answer, with a warning logged once per distinct error. Claude's `limits[]` rows are shown in the server's order and severity, so a new meter needs no change; Codex's windows are named by duration, since the weekly one can be `primary` or `secondary`.

### PTY lifecycle (`src/pty/mod.rs`)

- A `PtyHandle` is created when a pane is created but the shell is **lazily spawned** on first `/ws/pane` connection (`ensure_spawned`), using the cols/rows from the query string.
- Output fans out via a `tokio::sync::broadcast` channel, so multiple browser tabs can attach to the same pane. Replay uses `pty/replay.rs`: a bounded chunk journal (8 MiB per pane, 128 MiB
  shared history budget) plus a VT100 screen checkpoint at its head. Eviction
  advances the checkpoint. Resize events are journaled and broadcast in the same
  stream; resizing never clears history. The first interactive viewer owns PTY
  dimensions until it disconnects or another viewer claims them (the browser
  claims on keydown, paste, or mousedown). Followers and mirrors keep the
  ordered server sizes instead of fitting locally: a local resize reflows and
  clears the prompt, which the shell never redraws.
  `portable-pty` only opens the PTY and spawns the shell: btmux keeps its own
  close-on-exec master fd, sizes it with `TIOCSWINSZ`, and reaps the shell with
  `waitpid`. Readers poll the master and a per-pane stop pipe.
  PTY writes use a dedicated blocking thread and a bounded queue. Pane disposal
  signals the foreground group and kills the shell; a waiter reaps the child.
- **DA1/DA2 query interception** (`VtQueryInterceptor` in `pty/vt_query.rs`): the reader thread intercepts `ESC[c` / `ESC[>c`, injects canned responses back into the PTY input, **and strips the query bytes from the output stream**. The emulator _also_ answers DA (and DSR), but btmux is one PTY fanned out to many emulators — letting the emulator answer would hang detached panes (no emulator attached), duplicate the reply once per attached tab (the extra leaks to the shell and gets echoed, e.g. `^[[?62;22c`), and re-answer stale queries on scrollback replay. Stripping makes the backend the single responder, so its canned replies are what programs see, whatever the emulator would answer. Don't remove this without a replacement.
  Sequences over 1 MiB (`MAX_SEQUENCE_BYTES`, as in tmux) are dropped rather than
  streamed, in every parser state, since `vte`'s OSC buffer in the replay
  checkpoint is unbounded. A handoff carries a full buffer that refeeds into the
  same parser state and resumes dropping. A sequence aborted by ESC is forwarded
  closed with ST, as its replacement may be stripped, and bytes inside a bare ESC
  don't leave it, as in `vte`: either could leave the checkpoint in an OSC.
  Reads filtered to nothing add no journal event, and events hold no spare
  capacity (`exact_bytes`): the journal budget counts lengths, not allocations.
  The kitty keyboard query (`CSI ? u`) is answered the same way, from flag
  stacks the interceptor keeps per screen as libghostty does
  (`pty/kitty_keyboard.rs`); programs detect the protocol by its reply
  arriving before the DA1 reply. Flag changes still pass through to the
  emulators, which encode keys with them; replays end with the current
  stack (`Replay::viewer_snapshot`), since eviction can drop the pushes.
  Shells get `TERM=xterm-256color` and `TERM_PROGRAM=btmux`, without the
  server's own terminal or multiplexer variables (`OUTER_TERMINAL_ENV`).
  Color queries (OSC 4/10/11/12, `CSI ? 996 n`) are answered the same way from the
  shared `pty/colors.rs` palette, overlaid with colors the program set in that
  pane (OSC 104/110–112 and RIS reset them; mixed set/query OSCs are split);
  `SessionManager::sync_palette` sends `CSI ? 997 ; Ps n` to panes that set
  mode 2031 when the theme changes. Replies are queued once per read and dropped
  if the input queue is full.
- **Termios** is set manually on the PTY master (`configure_termios`: `IUTF8`, `ECHOK`, `IMAXBEL`) because `portable-pty` opens the PTY with NULL termios; without `IUTF8`, fish misbehaves.
- **Working directory**: shells report it with OSC 7. On Unix, until one does,
  the reader takes it from the OS (`/proc/<pid>/cwd`, `proc_pidinfo`) after each
  output chunk while the foreground group's leader is a shell (the pane's or a
  nested one, by name), so `make -C` doesn't move it. An OSC 7 naming
  another host marks the cwd remote (`local_cwd()` is then `None`).
- **Git identity** (`pane_git.rs`): `PaneSnapshot.git` gives each pane's repo
  (keyed by the common git dir, so worktrees of one repo match), worktree root,
  and branch. `GitTracker` resolves local cwds from the filesystem on a worker
  thread (symlinks resolved on Unix, as git does), caches them (stale entries
  are served while revalidated after 10 s, for `git init` or a removed `.git`),
  and watches each worktree's git dir (and, for linked worktrees, `worktrees/`
  and the common dir, since removal isn't reported otherwise); changes signal
  `meta_tx`. Not persisted. Windows and sessions
  have no identity of their own: `lib/gitIdentity.ts` derives it from their
  panes for the session switcher's repo/branch tokens (colored per repo) and
  its filter. While open, the switcher polls `git_status` on `/ws/files` for
  each worktree (`useWorktreeStatuses`) and shows the file browser's status
  symbols on its tokens; a repo token sums that session's worktrees of the repo.
  Polling pauses in a hidden tab; a scan that fails or takes over 30 s marks its
  token out of date until a reply.
  `worktree.rs` creates a worktree (`worktree-path`, default
  `../<repo>-<branch>`) with a window and removes one, closing its panes, for
  the control socket (`prefix + W`/`X`), REST, MCP, and `btmux
  new-worktree`/`remove-worktree`; it runs the `git` CLI off the lock.
- **GitHub status** (`github.rs`): the pull request and CI checks of each pane
  branch, from `gh api graphql` (`[github] enabled`, default on), so btmux
  never reads a credential; `gh` is found as plan limits find agent CLIs, but
  polling starts the shell for its `PATH` only once. Only
  github.com and `[github] hosts` are asked, always with `--hostname` (gh sends
  `GH_ENTERPRISE_TOKEN` to any host, and follows `GH_HOST`). The repo's git
  config on disk gives the GitHub repo: gh's default (`gh-resolved = base`),
  else `upstream`, else the push remote; a PR's head owner must match the push
  remote's `pushurl`, else its `url`. The branch's name there is its upstream's
  only with `push.default = upstream`, as in `git push`. Git config and
  `packed-refs` are reparsed only when their size or mtime changes. Check counts
  come from the rollup's `*CountsByState`, grouped as `gh pr checks` does, names
  from its first 100 contexts. One query per repo covers its branches, all repos
  at once, polled every 60 s while a control socket is connected, every 15 s for
  30 minutes while checks are pending or for 2 minutes after the remote-tracking
  ref moves (a push or fetch), which also refreshes at once. Errors back off 5
  minutes; a second in a row, or `gh` going missing, drops the status. `ServerMessage::Github` carries
  every status on change and on connect; `GithubBadge` shows it in
  `PaneCorner` (and the title bar) for every branch on GitHub, with or
  without a PR or checks, opening the PR or branch on click. The
  browser tests' fake `gh` (`frontend/test-bin`) answers from the stack's `gh`
  directory.
- **Windows shells** (`shell.rs`): `shell` is a command line (`wsl.exe -d Ubuntu`)
  whose program picks a `Dialect` (PowerShell, cmd, POSIX for Git Bash, WSL) for
  typed commands (`cd`, `open-editor`, capture-pane) and paths. `pty/windows.rs`
  adds prompt hooks that report the cwd with OSC 7: PowerShell's `-Command`,
  cmd's `PROMPT`, bash's `PROMPT_COMMAND`/`PS0` (passed into WSL by `WSLENV`).
  Git Bash and WSL programs aren't the shell's Windows children, so their
  foreground check uses the bash hook's OSC 133 marks instead of the process tree.

### Persistence and profiles

`persistence.rs` saves the session/window/pane tree, layouts, names, active
indices, and last-known pane cwd to `$XDG_STATE_HOME/btmux/state.json` (falling
back to `$HOME/.local/state/btmux/state.json`). `--profile NAME` uses a separate
`<profile>/state.json` and token file. Running processes and scrollback are not
restored; restored panes spawn fresh shells lazily in their saved cwd. A
per-profile OS file lock prevents two btmux processes from owning the same
profile.

`btmux upgrade` (`handoff.rs`) keeps them instead: it asks the profile's server
(`POST /api/server/upgrade`) to re-exec into the CLI's binary in the same
process, after running that binary's hidden `handoff-version` with the
server's arguments, which the exec passes on. It refuses
while the built-in Neovim has unsaved changes. The server holds the state
lock, quits Neovim (`:qall`) and stops VS Code, stops every PTY reader (unread
output stays in the kernel), and writes session snapshots, replay
journals, title/cwd, program-set colors, kitty keyboard flags, OSC 133 prompt state, agent telemetry, any partly read escape sequence, and
accepted input not yet written to the PTY (the writer stops too)
to an unlinked file. PTY masters, the listener, the profile lock, and that
file survive `execve`; shells stay its children. The new process takes them
over through `BTMUX_HANDOFF` before anything spawns; browsers reconnect and
replay. Tabs get a toast when an upgrade starts or is refused; after
reconnecting, the frontend toasts a changed server version. If the exec fails,
the readers and writers restart, tabs get an error toast, and `btmux upgrade`
reports the error (`upgrade_error` in `/api/info`). If a pane's reader or
writer doesn't stop within 2 s, the upgrade fails before the exec; one that
stops later restarts without its state. `handoff-version` prints
the handoff version and the btmux version.
It exits with status 3 whenever the server keeps running unchanged, and checks
the pid to tell an exec from a service manager's restart. Bump
`handoff::VERSION` whenever the handoff file changes; `just protocol` then
records its shape in `src/handoff.schema`, and the tests reject a changed shape
without a bump. The Home Manager module upgrades this way when only the package
changed, and doesn't restart on status 3.

`discovery.rs` is shared with the Tauri launcher. After binding, standalone
servers (not bundled desktop servers) publish an owner-only `state.server`
record beside their state file, containing the loopback endpoint and
credential; normal shutdown removes it. The desktop
startup picker probes these records through the authenticated API and installs
an HTTP-only cookie before connecting. Reused servers remain independently
owned; only a bundled private server is stopped when the desktop app exits.
With "Keep it running after btmux quits", the launcher starts the bundled server
detached (own session, no parent watch, null stdio) so it registers and
outlives the app; the picker stops desktop-profile servers through
`POST /api/server/shutdown`. Connected pages return to the picker through
`switch_server` (the palette's "desktop: switch server") and open another
window on it through `new_window` ("desktop: new window", ⌘N on macOS);
the launcher keeps each window's listed servers and watchdog by label, and
capabilities match every window (`*`).
Remote servers (`desktop/src-tauri/src/remote.rs`) are saved by origin and
token in an owner-only file and checked through `/api/info`, whose `Set-Cookie`
names the auth cookie to install. Connecting adds a runtime capability that
gives the remote origin the commands `capabilities/notifications.json` gives
loopback pages.

### UI and theme

Astryx provides the app shell, navigation, forms, dialogs, tabs, and notifications.
Follow `frontend/AGENTS.md` and inspect component docs with `cd frontend && npx
astryx component <Name>`. `BtmuxTheme.tsx` derives the Astryx theme from the
resolved terminal palette and font family, including settings previews; semantic
colors and contrast belong in `lib/astryx-theme.ts`.
Loading indicators use `components/Spinner.tsx` (the app mark's wave), not
Astryx's `Spinner`; Astryx `Button`/`IconButton` `isLoading` still draw its ring.

Fonts: body text and headings use Geist Sans; the Astryx code role (and `Kbd`)
uses the configured terminal font. Identifiers and code-like chrome go in
`.btm-mono` (`index.css`), which also remaps `--font-family-body` and
`--font-weight-normal` so Astryx inputs and menus inside follow the terminal
font and weight. It covers the status bar, pane titles, file
browser, process viewer, Neovim surface, command palette labels, and
session/window names; prose, labels, and descriptions stay sans. Geist Pixel is
only for the "btmux" wordmark in the sidebar header and About dialog
(`.btm-brand`: 40px, `ELSH` 40 = the "Grid" instance); smaller, it loses its
pixel grid.

Terminal geometry, live mirrors, and file previews retain specialized rendering.
UI navigation must preserve terminal and socket lifetimes.

Touch devices (`(pointer: coarse)`, `lib/touch.ts`, as wterm decides) get
`MobileKeyBar` above the status bar. Its keys go through
`PaneTerminal.pressKey`, a synthetic keydown on wterm's textarea, so
keybindings and wterm's encoding (kitty protocol, cursor modes) apply, or to
Neovim's input when it has focus; taps
prevent `mousedown`, not `pointerdown` (which cancels a tap's click in WebKit),
to keep the keyboard open. Its keys go to a focused text field (pane search)
instead, and it has a key to hide an editor covering the active pane, since
VS Code ignores synthetic keys. Armed Ctrl, Alt, or prefix apply to the next single
character typed, including text sent without key events or committed by a
composition; longer text (a suggestion) passes through and disarms them.
`useVisualViewport` sizes `#root` to the visual
viewport, since iOS doesn't resize the layout for the keyboard. Swipes in
alternate-screen or mouse-tracking programs become wheel events. Below 768px,
`SessionPane` shows only the active pane, a local zoom, and the file browser
and process viewer are fullscreen, showing a list or, after a tap, the
preview or details. Footer key hints everywhere type their key when tapped
(`usePressHint`); on touch screens, filters type into an input and a tap on a
session switcher window switches to it.
`mobile-browser-test.ts` covers these in WebKit with iPhone emulation.

### Process viewer

`prefix + t` opens it (`ProcessOverlay.tsx`) over `/ws/processes`, which sends a
snapshot of all processes each second while open, with sockets in every third,
since on Linux reading them walks every process's open fds. It is split in two
(`Tab` switches; one at a time below 768px): the process or port list, and
per-pane usage. The server assigns each process a `pane_id`, from its nearest
ancestor that is a pane's shell, else the shell leading its session
(`AncestorPanes`), so a daemon that calls `setsid` and reparents counts for no pane,
nor do the built-in editors and browser. Threads aren't listed. On Windows, Git
Bash and WSL programs aren't the shell's descendants, so those panes are marked
as not counted. `lib/paneUsage.ts` groups by session, window, and pane, summing
CPU (100% is one core), resident memory (shared pages count once per process),
disk rates, and listening sockets, listed under panes. That is TCP in `LISTEN`
and UDP below the ephemeral range, as nothing tells a UDP server from a client.
Sessions start folded. On the usage side, the list shows only the processes and
ports of the focused row's panes; going back keeps that scope, so the list doesn't
change under a click, until Esc clears it or the row goes away (a closed port's
row hands focus and scope to its pane).

### Frontend lifetime and routing

`useControlSocket.ts` mirrors pushed `sessions`, `all_sessions`, and `config`
into the Zustand store. `App.tsx` derives the active session/window route from
`/s/<session>/w/<window>`; there is no server-side current session. The session
pool keeps up to four recently visited sessions mounted, while hidden panes are
suspended rather than torn down. The window grid is sticky after first open and
uses `mirror=1` pane sockets. Modal surfaces (`Overlay`, the session switcher,
window grid, and file browser) own keyboard input while open.

The file browser has a separate `fileStore` for directory/search/Git selection
state. It can mutate files, so changes to its WebSocket protocol or path
handling must be reviewed with `ws/files.rs`, `fs_ops.rs`, and
`frontend/src/protocol/file-messages.ts` together.

### Terminal emulator

`lib/paneTerminal.ts` (`PaneTerminal`) is the only module that touches wterm.
`TerminalPane`, `MirrorPane`, search, LaTeX scanning, capture-pane, and the
browser tests use its API. `open()` is async (core load and `init()`), so mount effects check for disposal
after each await. It also undoes `init()`'s side effects: the focus it takes
(panes focus themselves once their replay is shown) and the element height it
locks. Its input stays `visibility: visible`, so a pane can take focus while
its replay is hidden; tests find it by wterm's default label, "Terminal". The
host sets wterm's row height (`--term-row-height`, 17px by default): `open()`
sets it from the font's ascent and descent before `init()` measures it.
wterm's `onData` stays non-null (null makes wterm echo input locally);
`disable-stdin` drops input in `PaneTerminal`. `paste()` dispatches a
paste event so wterm's paste path (bracketed paste, ESC stripping) applies.
A paste with an image and no text (which wterm ignores) is uploaded to
`POST /api/panes/{id}/paste-image` (`paste_image.rs`), saved in a private
temp dir removed on shutdown, and its path pasted instead; Claude Code and
Codex attach a pasted image path as an image. wterm leaves Ctrl+V to the
browser as paste; on macOS, which doesn't paste with it, `PaneTerminal`
marks it delivered so wterm encodes it as a key (Claude Code's image paste).
wterm keeps cell measurement private, so `measureCell()` reads its CSS cell
dimensions; the decoration overlay uses the same geometry. `open()` waits for
fonts before measuring, including for mirrors. Recheck measurement when bumping
`@wterm/*`.
Scrollback scrolls natively (`scrollTop` on the element); `PaneTerminal` throttles
application wheel input, delegates mouse encoding to wterm, and emits arrow keys
for alternate-screen programs without mouse tracking. Text and raw mouse input
share a byte callback. wterm links only OSC 8 hyperlinks; `PaneTerminal` finds
plain-text URLs (`lib/urlDetect.ts`, across soft wraps) under the pointer, which
Cmd-click (Ctrl elsewhere) opens without reaching the application. The desktop
app opens `window.open` URLs in the default browser. Theme, font, and
transparency are CSS variables and classes on the element.

### Built-in Neovim

`prefix + e` (`editor` action) opens the `editor` setting. With `neovim`, it toggles a Neovim GUI over the active pane
(`NvimSurface.tsx`), or moves it there if it is pinned to another pane; a
second Esc within 300 ms also hides it (the first still reaches Neovim). The
surface is pinned to that pane (`nvimPaneId`; the active `SessionPane`
publishes its rect as `nvimRect`): other panes stay visible and usable,
zooming the pane makes it fill the window, and it is hidden while the pane's
window isn't shown. It owns the keyboard only while its pane is active; clicking
it selects the pane. The backend lazily spawns one shared
`nvim --embed --headless --listen <private socket>` per server; `--embed` ties
its lifetime to btmux's stdin pipe. It starts with `g:btmux = 1`, which user
config can check, and the bundled plugin on 'runtimepath'. Each browser tab
attaches its own UI (`ext_multigrid`, `ext_cmdline`, `ext_popupmenu`,
`ext_messages`, which sets 'cmdheight' to 0 and drops hit-enter prompts).
Neovim replays its state on attach, so there is no journal, except window
grid cells it already sent to other UIs: each attach first attaches and detaches
without `ext_multigrid`, which frees those grids so the real attach gets them in full. Each time the
surface is opened or moved, it sets Neovim's global cwd to its pane's. When Neovim exits
with status 0 (`:q`), the backend sends close code 1000 and the surface closes; a
crash or any other close shows a restart prompt. If the socket file disappears
while Neovim runs, the backend has it listen again over the `--embed` channel. Neovim enables `ext_*` features only if every
attached UI supports them, sizes the grid to the smallest UI, and defers
non-fast requests (including `nvim_ui_attach`) while blocked at a prompt.

`lib/nvimGrid.ts` keeps one layer per grid: grid 1 (statuslines, separators)
on the surface canvas, minus cells under visible windows (Neovim leaves closed
splits' separators there), and a canvas per window or float, positioned from
`win_pos`/`win_float_pos` in a host div that lets the mouse through to them.
Mouse events go to the grid under the pointer, with grid-relative cells.
Floats get an Astryx card frame behind their canvas (`NvimFloatFrames`): the
border reported by `win_viewport_margins` is cropped, its title is fetched for
the frame, and cells with the NormalFloat background stay transparent.
'winblend' arrives as `blend` on each cell's highlight: it sets the frame's
background alpha (blurred by `--btm-backdrop-blur`) and other cell backgrounds'
alpha, never the text's; 'pumblend' does the same for the popupmenu cards. As
in wterm, rows draw printable ASCII runs of one highlight with one `fillText`
(so fonts join ligatures; cell by cell for proportional fonts), other cells
alone, and light/heavy box drawing, rounded corners, and block elements as
shapes to the cell edges; text uses `[terminal] font-weight`, bold 700. Each
layer draws dirty rows to an offscreen canvas, and each flush composes it onto
the visible canvas with in-flight
`grid_scroll` animations (a snapshot of the region plus an eased pixel offset;
`[terminal] smooth-scroll-duration`, off with `animations = false`; scrolls of
the whole region or more animate one row); layers with no dirty rows or scrolls
are skipped. The cursor has its own canvas, last in the layer host with its
grid's z-index, so it stays above its window and below higher floats, and
moves between cells and windows with an eased slide (`[terminal]
cursor-animation-duration`; a cell or two along a row jumps). Unset `Normal` colors fall back to the btmux theme, as in a TUI,
and 'background' is set from the theme's luminance. 'guifont' (Neovide format,
`lib/nvimFont.ts`, with `:h`, `:b`, `:i`, and `:w`) and 'linespace' override
the btmux terminal font; 'guifont' at Neovim's default doesn't. Keys go
through `lib/nvimKeys.ts` to `nvim_input`: F-keys and Cmd (`<D-…>`) reach
Neovim, except Cmd shortcuts the browser or desktop app keeps; the global
keybinding hook lets them through for the `data-nvim-input` textarea, which
follows the cursor so IME candidates and compositions appear there. Its focus
and blur go to `nvim_ui_set_focus` (`FocusGained`/`FocusLost`); unfocused, the
block cursor is an outline and stops blinking ('guicursor' blink times). Wheel
steps follow 'mousescroll'; 'mousemoveevent' sends hover moves, and 'mousehide'
hides the pointer while typing. `suspend` (CTRL-Z) hides the surface, and a
bell flashes it.
`lib/nvimWidgets.ts` reduces cmdline, popupmenu, and message events and
publishes them once per `flush`; `NvimWidgets.tsx` renders them as Astryx
components. Short messages (echo, `vim.notify`, errors) are expiring toasts;
multi-line output (`:ls`, `:!cmd`, `:messages`, prompts) is a panel the next
normal-mode key dismisses. Neovim never sends `msg_clear` in normal use, so
btmux owns dismissal. Fenced code in completion and signature docs is
highlighted by its fence language with highlight.js in the terminal theme's
colors (`lib/syntax.ts`, shared with file previews).

The plugin in `extras/nvim` (`require("btmux")`) sets itself up after user
config unless the config called `setup()` first. It forwards completion docs
(`btmux_complete_info`, by wrapping the internal `nvim__complete_set`, and
hides Neovim's own doc float), LSP signature help (`btmux_signature`,
triggered on `InsertCharPre` because `TextChangedI` waits for typeahead), and
progress (`btmux_progress`: `LspProgress` becomes a progress-message, and every
`Progress` event is forwarded with the status and percent `msg_show` lacks;
Neovim's own file I/O progress shows only its result, since 0.12 never finishes
the one for reads), and completion kind icons from mini.icons
(`btmux.kinds.icons()`, requested after attach; `btmux_kind_icons` on
colorscheme changes). Astryx typography falls back to the bundled Nerd Font so
such glyphs render outside the grid too. These
`rpcnotify(0, …)` messages are a private protocol between the plugin and
`NvimSurface.tsx`: change both together. `btmux.health` (`:checkhealth btmux`)
detects plugins and settings that duplicate or break this UI; the plugin
toasts once after the first `UIEnter` if it finds any.

The `editor` setting (default `neovim` if `nvim` 0.12+ is on `PATH`, else `pane`) makes file browser and Git mode opens send
`nvim_open`, which opens the file via `--remote-expr` on the shared socket;
`vscode` sends `vscode_open`; `pane` keeps the older `open_file` path (the
pane's foreground Neovim, else `$EDITOR` in its shell), which `prefix + e`
sends without a path. `btmux open-editor [FILE] [LINE] [--kind EDITOR]` asks its pane's
server (`POST /api/panes/{id}/open-editor`, `--kind` overriding the setting): with `neovim` it opens the file
and broadcasts `open_nvim` to show the surface; otherwise, or outside btmux, it
execs `$EDITOR`.
`ClientConfig.editors` lists the editors the server can run (`nvim::available`,
`vscode::available`); the status bar shows a button for each, after the
configured one, and the unbound `editor-neovim`/`editor-vscode` actions toggle
one regardless of `editor`.

### VS Code

With `editor = "vscode"`, `prefix + e` toggles VS Code over the active pane
(`VscodeSurface.tsx`), pinned and hidden by a double Esc like the Neovim
surface; only one of the two
covers a pane. `src/vscode.rs` lazily spawns one VS Code server per btmux
server, without a connection token, on a private Unix socket, and proxies
`/vscode/` (HTTP and WebSocket) to it behind `auth.rs`. `[vscode] server`
picks it, read when it starts: `code` (default) runs `code serve-web` from an
installed VS Code (`code` on `PATH`, else the macOS app bundle), which
downloads the matching server on first use; `openvscode-server` (on `PATH`)
is opt-in. The surface first calls `GET /api/vscode`, which starts the server
and reports `ready`, `license`, or an error. The desktop `code` CLI doesn't
enforce the VS Code Server license, so btmux asks once per profile
(`POST /api/vscode/license` writes `<state dir>/vscode/license-accepted`) and
then always passes `--accept-server-license-terms`. The server runs in its own
process group, since `code` is a wrapper that starts several processes. User
data and extensions are per profile (`<state dir>/vscode`, the same layout for
both servers). The iframe is same-origin,
so the surface replays its keydowns to the keybinding hook and swallows those
btmux handles. Moving an iframe in the DOM or changing its `src` reloads VS
Code: it reloads only when opened over a pane in another folder. WKWebView rejects VS
Code's `navigator.clipboard` reads, so in the macOS desktop app Cmd+V in its terminal
skips VS Code and takes the Edit menu's paste. Don't grant the webview clipboard access:
WebKit's preferences and WebView2's permission let any frame read it without a gesture.

The extension in `extras/vscode` is embedded and installed into the profile's
extensions on each start, registered in VS Code's `extensions.json` (the
server ignores `--builtin-extensions-dir`) under a folder named with a hash of
its files, so any change makes VS Code rescan it. It connects back over
`BTMUX_VSCODE_SOCKET`, which carries newline-delimited JSON: `user` (shared
settings and keybindings, on connect and when their paths change), `style` (the
base16/24 `color_palette` and the terminal font, on connect and on every
change), and `open`
(`editor = "vscode"`, `vscode_open`, `btmux open-editor`). The last open is
replayed to extension hosts that connect within 30 s, as VS Code may still be
starting or reloading. The extension writes the palette and font to user
settings (color customizations and the editor and integrated terminal font,
the editor at 80% size;
`btmux.syncTheme` and `btmux.syncFont` turn them off), which VS Code for the
web keeps in the browser. Bundled fonts are web fonts, so the surface copies
this page's `@font-face` rules into the iframe on each load. Change both sides
of this protocol together.

`[vscode] desktop` (or `settings`, `keybindings`, `extensions` paths) shares
desktop VS Code's user files and extensions. The server parses the JSONC files
and sends them as `user`; the extension, handling messages in order, replaces
`vscode-userdata:/User/settings.json` (keeping the theme and font keys it
wrote, so they don't flicker) and `keybindings.json`. These live in the
browser's IndexedDB, so no file on disk can seed them, and machine settings
ignore application-scoped keys. On each start, `link_extensions` registers
shared extension folders in `extensions.json` by absolute location, reading a
source's own `extensions.json` (minus `.obsolete`) when it has one, and
replaces those `<state dir>/vscode/linked-extensions.json` lists.

### Sandboxed sessions (Multipass)

A session's `Runtime` (`session/mod.rs`, persisted) is `Local` or `Multipass {
mounts, shell }`. Sandboxed sessions share one instance (`[multipass]`,
`multipass::instance_name`: `btmux-sandbox`, `-<profile>` appended). Mounts are
host directories mounted at the same path (`check_mount` refuses home and its
ancestors), so cwds mean the same on both sides; `mounts` adds the git dir a
worktree root's `.git` file names (a linked worktree's repository), without
which Git in the guest finds no repository. Worktrees made or opened in a
sandboxed session are added to its mounts (`with_mount`); validation reads
the filesystem, so it runs off the lock. A guest pane's PTY runs the
hidden `btmux guest-shell` (`multipass.rs`), which under a file lock creates
(cloud-init: packages, shells, Claude Code, Codex) or starts the instance,
mounts, installs this version's Linux binary at `GUEST_BIN` (copied from a Linux
host if the copy runs there, else the matching release, or the latest, recorded
in `INSTALLED_FOR` so it isn't fetched again) with agent hooks, writes the bash/zsh/fish
integration (OSC 7 with the guest hostname, OSC 133), printing progress in the
pane, then execs `multipass exec … <shell> -l`, which reads the guest token
from a guest file (`GUEST_TOKEN`), never arguments, which process lists show.
Until the first OSC 133 mark the pane counts as running a program. On failure
it waits for Enter. A shell that exits nonzero while the instance no longer
answers (stopped, deleted) gets an offer to start or create it again, so
sessions survive; the wrapper ignores the terminal's job-control signals while
the shell runs. `[multipass] copy` lists home files sent as a ustar archive
(symlinks followed) on each start, skipped when its hash matches the guest's
`COPIED`. `GET /api/multipass` (`InstanceStatus`) and `POST
/api/multipass/{start,stop,restart,delete}` back the status bar's
`MultipassButton`; actions refuse while a pane holds the setup lock. Files reach Multipass on stdin (`--cloud-init -`,
`write_in`), never by host path: snap Multipass can't read the host's `/tmp`
or hidden directories.

Guests reach the server through `POST /api/multipass/bridge`, which the wrapper
calls with the host token and the instance's default gateway: the server binds
a second listener there (unless it listens on all addresses), allows that
authority, and returns it with the guest token (`state.guest-token`, kept so
shells survive restarts; `restore_bridge` rebinds at startup). `auth::protect`
lets the guest token reach only `guest_route`s (pane notify, agent status,
telemetry, widgets, `/api/notify`), drops `X-Btmux-Agent-Pid` (guest pids name
no host process), sets no cookie, and `server::guest_scope` checks the pane is a
guest's. Never widen this without considering that the guest is untrusted.
Guest panes use the Posix dialect, OSC 7 under a mount from the guest host is
local (`Guest::mounted`), the `/proc` cwd fallback is off, and the foreground
group comes from OSC 133 marks (unix `Probe`), as for WSL. Host-typed
editor opens pass `--kind pane`, and the CLI takes a 403 as `$EDITOR`. Pasted
images and captures are copied into the guest's `/tmp`.

### Browser surface

`prefix + b` (`browser` action) toggles a browser over the active pane
(`BrowserSurface.tsx`), or moves it there; it is pinned and hidden by a double
Esc like the Neovim surface, and only one surface covers a pane. Unlike an
iframe, which can't take keys from a cross-origin page or show the many sites
that refuse framing, it is a canvas showing one headless Chromium per server
(`src/browser.rs`), so `localhost` means the server. `ClientConfig.browser` says
whether Chrome or Chromium was found (`PATH`, then the macOS app bundles); Unix
only. The profile (`<state dir>/browser`) keeps logins and the last web page
(`btmux-last-url`), which is reopened whenever Chromium starts, and a tab
reconnects by itself after a crash or an upgrade, so both only flash a spinner.
`[browser] search-url` sets where the address bar searches (`addressToUrl`).
`block-ads` (`--host-resolver-rules` from `extras/browser/ad-hosts.txt`) and
`block-autoplay` (`AUTOPLAY_SCRIPT`, in every frame: `Target.setAutoAttach`
reaches iframes in other processes) default on and are read when Chromium
starts, so changing either restarts it. A playing video keeps the page
painting, and each paint is a full-size JPEG. Activation doesn't reach
cross-origin children, so the script posts input down to frames with
`allow="autoplay"`, which count as activated for 5 s, like a click on them.

Chromium is driven over `--remote-debugging-pipe` (fds 3 and 4, NUL-delimited
JSON), so it opens no port and exits when btmux does. There is one page: a page
opening another (`target=_blank`, `window.open`) navigates it instead, and
JavaScript dialogs are answered automatically. A popup still on `about:blank`
after 5 s is closed, and a page crashing three times in a minute is replaced with
a notice and no longer reopened. Internal pages Chromium opens
itself are left alone, so only targets whose `openerId` is ours count.
A person drives this browser, so it doesn't report automation:
`--disable-blink-features=AutomationControlled`, and the user agent and its
metadata read as the desktop browser. Agent-driven control (such as MCP tools)
should report it, so keep that out of this path.

`Page.screencastFrame`s are acked at once, and each socket sends a tab the
latest frame only after the tab acks drawing the last, so a slow link skips
frames. The screencast can't be trusted for a quiet page's final state: it
misses a paint made while it attaches, and its last frame may be low resolution.
So `Browser::settle` captures a screenshot after 150 ms of quiet; frames right
after a capture don't count as paint, since a capture itself makes one. Sockets
exist only while the surface is shown.

CDP reports neither the cursor nor the selection, so both use `Runtime.evaluate`.
`track_cursor` asks what is under the pointer at most every 50 ms, and tabs get
only keywords from `CURSORS`, since a page's `url()` cursor would load in the
tab. Cmd+C (Ctrl+C off macOS) sends `copy` for the selection, never a password
field's, and starts a `ClipboardItem` write with a promise, within the key
press, as Safari requires. It covers selections, not a page's own copy buttons,
whose writes stay in Chromium.

The device scale is process-wide, from the first viewer (at most 2):
`--force-device-scale-factor` is the only way to get 2x frames, and
`setDeviceMetricsOverride` must pass scale 0 to keep it. Sizing follows the PTY
rule: the first tab owns it until another sends input, and a click claims it
only on release, since its coordinates are for the frame the tab was showing.
Keys whose text comes from the browser (dead keys, IMEs, AltGr) and the client's
paste chords aren't canceled, so they reach `input` and `paste`, and `prefix
prefix` goes to the page when the browser covers the active pane. Headless
Chromium on macOS maps no editing chords, and elsewhere doesn't map a Mac's, so
`editing_commands` sends CDP `commands` based on the tab's platform (`?mac=`) and
the server's; with neither a Mac, Chromium maps them itself.

### Layout tree — the shared contract

`Layout` (`src/session/layout.rs`) is a recursive binary tree:
`Leaf` / `VSplit` / `HSplit`. It is serialized with serde `tag = "type"`,
`rename_all = "snake_case"`, and the frontend's `LayoutNode`
(`frontend/src/state/types.ts`) plus `computeRectsAndDividers` in
`frontend/src/state/layout.ts` decode it into percentage-based rects. **After changing Rust wire types, run `just protocol`.** Test-only `ts-rs`
derives generate `frontend/src/generated/protocol.ts`; frontend aliases preserve
existing import names. The generated layout is a discriminated union.

### Protocol magic numbers and session routing

`switch_window` uses sentinel indices: `-1` = next, `-2` = prev, `>=0` = absolute.
Resolved by the shared `resolve_index` helper in `manager.rs`; the senders live
in `useKeybindings.ts` and the REST window API. There is no server-side
`switch_session` command: session changes are URL navigation, and `last-session`
uses tab-local `sessionStorage`. Keep the URL/session-name routing and shared
window/pane selection behavior in sync.

### Config + keybindings (the data-driven keymap)

Config is a TOML file at `$XDG_CONFIG_HOME/btmux/config.toml` (falling back to
`$HOME/.config/btmux/config.toml`), parsed in `src/config.rs`. All fields
optional: `prefix` (tmux-style, e.g. `"C-a"`), `shell` (CLI `--shell` still wins),
a `[keys]` table mapping **action name → key** to override defaults, appearance
settings (wallpapers, shaders, sorting, animations, pane titles, and window-grid
count), a `[terminal]` table of emulator options, an optional `[log]` table,
and `appearance` with dark and light color schemes. `deny_unknown_fields` makes typos a
config error, so update `generate_config_toml` and tests when adding fields.

`[terminal]` holds `cursor-blink`, `scrollback` (lines; libghostty's limit is
bytes, so `lib/paneTerminal.ts` converts it), `font-size`, `font-family`,
`font-weight`, `allow-transparency`, `disable-stdin`, `macos-edit-keys` (Cmd
editing chords as readline keys, `lib/macEditKeys.ts`; `useKeybindings.ts`
lets them through), `smooth-scroll-duration` (Neovim and file preview scrolling), `cursor-animation-duration` (Neovim cursor moves), and
`cell-background-opacity` (the Neovim surface's colored cell backgrounds over a
transparent background). Keys are **kebab-case in TOML but camelCase on the wire**
— `TerminalOptions` uses `rename_all(serialize = "camelCase", deserialize = "kebab-case")`
so the same struct round-trips both ways. Unset fields serialize as `null`, and
the frontend applies its `CONFIG_DEFAULTS` (`state/configDefaults.ts`).

There are dark and light schemes. `appearance` (`auto`, `dark`, `light`)
picks the shown one; `auto` uses the system color mode browsers report
(`?color_mode=` on `/ws/control`, then `system_color_mode` on change and focus;
last report wins), held in `SessionManager` and passed to `resolve_binds`. The
shown variant is shared server state, like the theme PTY color queries answer.
`ClientConfig` carries `theme`/`color_palette` for it, its `color_mode`, and
both `dark_theme`/`light_theme` for previews and the first-paint cache.
`[theme-dark]`/`[theme-light]` are inline base16 (`base00`–`base0F`) or base24
(adds `base10`–`base17`) palettes. `colors-dark`/`colors-light` may instead name
a palette in the config colors directory, an absolute or `~/`-relative YAML
path, or an HTTP(S) YAML file; both top-level and `palette`-wrapped documents
are supported. An inline palette takes precedence. Schemes in `extras/colors/`
are compiled in (`BUNDLED_COLOR_SCHEMES`) and resolvable by name; a
colors-directory file of the same name wins. Unset, the server uses
`btmux-default-dark`/`btmux-default-light`. The frontend's
`FALLBACK_DARK_THEME`/`FALLBACK_LIGHT_THEME` (`state/startupTheme.ts`) mirror
them for first paint and are checked by a Rust test.
`BaseTheme::to_theme`
translates it to a `Theme` (fg/bg/cursor/
selection + 16 ANSI colors) using the canonical tinted-theming ANSI mapping. **base24
is auto-detected by the presence of all of `base10`–`base17`** (all-or-nothing; a
partial set falls back to base16); base24 then uses the dedicated bright slots
`base12`–`base17` instead of reusing the normal accents. The translation happens on
the **backend** — the browser receives a finished `Theme`. Live reload updates themes and transparency in place. Only construction-option changes
(fonts, scrollback, etc.) rebuild terminals; unrelated config changes
and shader updates keep emulator instances and sockets alive.

`config.rs` is the **single source of truth for keybindings**: `DEFAULT_BINDS`
holds the tmux-style defaults, `resolve_binds` merges `[keys]` overrides over them,
and the resulting `ClientConfig { prefix, binds: [{key, action}] }` is serialized to
the browser. Actions are kebab-case strings (`split-vertical`, `new-session`, …),
each mapping 1:1 to a case in `runAction` (`useKeybindings.ts`). **To add a binding
you must touch both:** add the default in `config.rs` and the handler case in
`useKeybindings.ts`. `0-9` window-select is special-cased in the frontend, not in
the bind table.

`useKeybindings.ts` parses the configured prefix (the frontend matches `C-`/`M-`
modifiers + key),
captures keys in the capture phase, and on the second keystroke either sends a
`ClientMessage` or opens an **overlay** (`components/Overlay.tsx`): `prompt`
(rename window/session, new session), `keys` (keybinding help), `command`
(command palette), `picker` (colors/fonts), or `confirm`. While an
overlay is open the keybinding hook early-returns so typing goes to the overlay,
not the terminal.

**Shader wallpapers:** `shaders` provides native WebGPU generators and effects. The
wallpaper is an ordered stack of `[[wallpaper-shader]]` layers (`ShaderLayer`: shader,
enabled, blend mode, opacity, interactive, params; at most `MAX_WALLPAPER_SHADER_LAYERS`).
`wallpaperRenderer.ts` registers enabled layers as sibling nodes under one core renderer,
so an effect processes every layer beneath it, and reconciles edits in place. The
`wallpaper` image, if any, is an `ImageTexture` node beneath them; core never repaints
when media loads, so the renderer hooks its texture upload, and `ShaderWallpaper` shows
a DOM copy of the image until the canvas has drawn it (or when WebGPU fails). A changed
image gets a new node, since the loader ignores URL changes while a load is pending.
The loader rasterizes SVG only for URLs ending in `.svg`, so the renderer checks the
type (`HEAD`, or the `data:` prefix) and appends `#.svg`. An image
alone stays a plain DOM background. `ClientConfig.wallpaper` is the configured value;
`wallpaper_url` is what browsers load: `wallpaper.rs` serves local images and fetches
remote ones (no CORS needed, `image/*` only, size-capped, sandboxed CSP) at
`/wallpaper?source=<value>`. Settings validates the field through
`GET /api/wallpaper/check` (debounced, `useWallpaperCheck`), which returns that URL;
an edited wallpaper previews once checked, and a checked remote image fills the cache. Stack and
parameter changes may restart simulations. It adds runtime FPS, resolution, pause, seed,
and cursor controls. No terminal post-processing. `wallpaperCatalog.ts` resolves IDs and
kebab-case parameters. `just sync-shaders` regenerates parameter metadata and lazy loaders
from the pinned package (the `generators`/`effects` lists in `scripts/sync-shaders.mjs`)
and btmux's own shaders (its `local` set, listed among them), `defineShader` definitions
with a raw `wgsl` body in `frontend/src/shaders` (e.g. the pixel-art `Aquarium`). The script
runs under Bun and imports them, so they import only `shaders/std`. Their props without `ui`
aren't config parameters: the renderer sets `cssWidth`, the canvas width in CSS pixels, since
core's `logicalViewportSize` is that size times the capped device pixel ratio.
`just test-frontend` checks that metadata is current. The session-only override replaces
the whole `wallpaper_shaders` stack. GPU failure leaves the image or the theme background visible.
Core rendering has no telemetry collector.

`PANE_BORDER_STYLES` in `lib/paneSwitchBorder.ts` is a CSS-masked one-shot border
draw on the pane you switch to, controlled by `pane-switch-border` and
`pane-switch-border-speed`. Unknown border IDs fall back in the frontend, and `animations = false` disables
both animated shader and border effects.

**Modal backdrop:** every Astryx `Dialog` shares one `dialog::backdrop` rule in
`index.css`, driven by `backdrop-blur` and `backdrop-dim`. `useModalBackdrop`
(`hooks/useModalBackdrop.ts`) publishes them as `--btm-backdrop-blur` /
`--btm-backdrop-dim` on `:root`, from the effective config so Settings previews
them. There is deliberately no pane shader behind modals.

**LaTeX overlay:** frontend-only. `lib/latexDetect.ts` is a pure, tiered
heuristic detector (explicit delimiters → bare `[`/`]` blocks → `$…$` → bare
`( … )`) tested by `frontend/latex-detect.test.ts`; add fixtures there when
tuning it. `lib/latexScan.ts` (`useLatexScan`) reads the viewport ± a margin from
the emulator buffer, debounced, and validates candidates with KaTeX, which is
lazy-loaded via `lib/katexRender.ts` on the first candidate. wterm has no
render event, so `TerminalPane` pokes the scanner after each `term.write`. `toggle-latex` flips per-pane local UI state (`latexPanes` in
the store, not server state); `LatexOverlay.tsx` highlights source cells with
`term.setDecorations` (positioned divs over the rows), whose absolute buffer
lines go stale on every rescan.

**Live config reload:** `main.rs` watches the config file's _parent dir_ with
`notify` (to catch editors' atomic rename-on-save), debounces, re-resolves, and
broadcasts a new `Config`. A parse error logs and **keeps the last good config**
(the defaults at startup); `ClientConfig.config_error` carries the error: a banner
above the panes until the file loads, with the message in a `config-error` overlay.

**Session-only overrides:** the command-palette pickers and settings appearance
overlay send `update_config` and don't touch config.toml. They can override
the appearance, color schemes, fonts, animations, wallpapers, and shader/border settings.
`SessionManager` keeps the last-loaded `FileConfig` plus an accumulated
`ConfigUpdate` override layer, and `resolve_with_overrides` re-resolves the
`ClientConfig` from the two on every change. The overrides are for trying
settings out: they're dropped on restart and by `set_file_config`, i.e. on _any_
config-file reload. The settings dialog's Save sends `save_config`, which
merges the overrides plus its draft into config.toml with `toml_edit`
(`config/save.rs`, keeping comments and other settings), resolves its remote
palettes, and only then writes through symlinks, renaming a temp file over the
target, and installs it; the watcher skips the echo (`is_saved_config`). Saves
and reloads hold `CONFIG_LOCK` (`main.rs`) throughout, so concurrent saves
from several tabs each keep their changes. A read-only file, as Nix and Home
Manager install, fails with an error toast and the dialog shows its TOML to
copy. Anything added to the editor or pickers therefore needs a field in
`ConfigUpdate`, `ConfigUpdate::merge`, `resolve_with_overrides`, and
`config/save.rs`, plus the
generated protocol if the wire type changes.

## Asset embedding

`server.rs` uses `rust_embed` to compile `frontend/dist` into the binary at
build time. The binary serves the frontend from memory, so it works from any
working directory — no runtime dependency on the `frontend/dist` folder.
Vite's content-hashed `assets/` are served `immutable`; other files `no-cache`
with an ETag. Only these routes are compressed (gzip, Brotli; not woff2), since
compressing streamed responses would hold them back.
`ws/nvim.rs` embeds the Neovim plugin (`extras/nvim`) the same way and unpacks
it beside the Neovim socket each time it starts the built-in Neovim.

## Access boundary

Every backend route, WebSocket upgrade, and MCP call passes through `auth.rs`.
A profile's owner-only `state.token` contains its access credential, or
`BTMUX_AUTH_TOKEN` supplies one. Browsers use the token as their password; Vite's
frontend has an access-token form. Automation sends `Authorization: Bearer …`.
The token must be at least 4 URL-safe ASCII characters. Host and browser Origin
are checked against the local authority and explicit `--public-url` values;
forwarded headers do not grant trust.
PTY shells receive `BTMUX_AUTH_TOKEN` so generated notification hooks work.
`--public-url` adds explicit origins/authorities for Vite or a reverse proxy.
`--tailscale` (`tailscale.rs`) runs `tailscale serve` for the listening port and
allows that tailnet HTTPS origin once Tailscale reports it (`Auth::allow`). The
Serve config is machine-wide: btmux refuses a port whose route serves anything
else, and removes only a route it created, recorded in `state.tailscale` before
the command runs; setup and shutdown share a lock, so shutdown waits for a
command in flight. Once serving, it rechecks the route every 30 s and sets it
up again if it's gone.
Tailscale's identity headers are not trusted, since local processes can reach
the loopback listener too.
Its status (`TailscaleStatus`: starting, serving, error) is pushed to control
sockets as `ServerMessage::Tailscale` and is in `/api/info`; the status bar's
`TailscaleButton` shows it, with a QR code of a pairing link while its
popover is open: `POST /api/pair` issues a random code (single use, valid
2 min, at most 16 pending), and `protect` exchanges `GET /pair?code=` for the
auth cookie and a page that refreshes to `/` (from a scanner's page, a
redirect would stay cross-site and lose the `SameSite=Strict` cookie). It is
the only unauthenticated route; the
token itself never enters the URL. The desktop picker can start a kept-running desktop
server with `--tailscale`, on a saved port (`tailnet-port`, chosen below the
ephemeral port ranges); its card polls the status while shown.
Never print credentials, put them in URLs, or bypass this middleware for new APIs.
Only one running server may own a persistence profile (held OS file lock).

Control commands may carry `request_id`; each gets a `command_result` with the
same id and an optional error, sent only to its originating socket. State remains
server-authoritative and shared, including active window/pane selection; session
navigation in the URL is per browser. Lagging control sockets resnapshot config
and state. Lagging PTY sockets disconnect and reconnect to a fresh replay.
