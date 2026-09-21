# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## What this is

btmux is a browser-based tmux. A Rust/axum backend owns real PTYs and the
session/window/pane tree; a React + TypeScript frontend renders panes with the
`ghostty-web` WASM terminal emulator. The same authenticated server also
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
- `just fmt` (alias `just format`) — format the whole codebase (`cargo fmt` + prettier). **Always run this before committing.**

`just test` runs the Rust regression suite. `just protocol` regenerates the frontend
wire types; the tests reject stale generated types. `just check` and `just lint`
remain required compilation/lint checks. `just test-browser` runs
`frontend/reliability-test.ts`, which exercises authentication, origin rejection,
reconnect/replay, config updates, correlated command errors, and multiple viewers
against an isolated dev stack (`BTMUX_AUTH_TOKEN=... just test-browser`).
`just test-frontend` runs the frontend unit tests (`bun test`, currently the
LaTeX detector). `just record-demo` drives the production UI with Playwright.

The CLI also accepts `--host`, `--port`, `--profile`, `--shell`, `--public-url`,
and `--no-browser`; `install`, `uninstall`, and `restart` manage a per-user
launchd/systemd service.

## Style guide

Keep code comments and git commit messages extremely concise.
Use American English consistently.

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

2. **`/ws/pane/{pane_id}?cols=&rows=`** (`src/ws/pane_io.rs`) — one socket **per visible pane**, carrying raw terminal bytes. Binary frames = PTY I/O; a JSON text frame `{type:"resize",cols,rows}` resizes. On connect, a checkpoint and journal are replayed, followed by `ready`. The browser accepts input only after this initial replay completes.

   `?mirror=1` creates a read-only attachment for window-grid thumbnails. Mirrors receive output and ordered size frames but never resize or write to the PTY.

3. **`/ws/files`** (`src/ws/files.rs`) — correlated JSON request/response messages for the file browser. It supports directory/file metadata, tree and content search, rich previews, Git status/diff/stage/unstage/discard, rename, copy, move, trash, and delete. `prefix + f` opens file mode; `prefix + g` opens Git mode. Keep filesystem access behind the authenticated route and preserve path validation in `fs_ops.rs`.

4. **`/ws/sysstat`** (`src/ws/sysstat.rs`) — emits one JSON frame per second with per-core CPU, memory, and aggregate network rates for the StatusBar. The frontend reconnects this auxiliary socket independently.

REST handlers and MCP tools share the same `SessionManager`; structural mutations must call `broadcast_state` so browser tabs stay synchronized. REST lives under `/api` and includes session/window/pane/layout operations, pane input/output, notifications, and raw local-file serving. MCP is mounted at `/mcp`; tools cover session/window/pane lifecycle, `send_keys`, `read_pane_output`, and `run_command`. `run_command` appends Enter, captures ANSI-stripped output until 400 ms of quiet by default, and has a 15 s default timeout; quiet output does not prove process exit.

### PTY lifecycle (`src/pty/mod.rs`)

- A `PtyHandle` is created when a pane is created but the shell is **lazily spawned** on first `/ws/pane` connection (`ensure_spawned`), using the cols/rows from the query string.
- Output fans out via a `tokio::sync::broadcast` channel, so multiple browser tabs can attach to the same pane. Replay uses `pty/replay.rs`: a bounded chunk journal (8 MiB per pane, 128 MiB
  shared history budget) plus a VT100 screen checkpoint at its head. Eviction
  advances the checkpoint. Resize events are journaled and broadcast in the same
  stream; resizing never clears history. The first interactive viewer owns PTY
  dimensions until disconnect; followers and mirrors adopt the ordered sizes.
  PTY writes use a dedicated blocking thread and a bounded queue. Pane disposal
  signals the foreground group and kills the shell; a waiter reaps the child.
- **DA1/DA2 query interception** (`strip_and_answer_da_queries`): the reader thread intercepts `ESC[c` / `ESC[>c`, injects canned responses back into the PTY input, **and strips the query bytes from the output stream**. `ghostty-web` _also_ answers DA (and DSR), but btmux is one PTY fanned out to many emulators — letting the emulator answer would hang detached panes (no emulator attached), duplicate the reply once per attached tab (the extra leaks to the shell and gets echoed, e.g. `^[[?62;22c`), and re-answer stale queries on scrollback replay. Stripping makes the backend the single responder. The canned bytes mirror `ghostty-web`'s exact DA replies for the pinned build — re-probe if `ghostty-web` is bumped. Don't remove this without a replacement.
- **Termios** is set manually on the PTY master (`configure_termios`: `IUTF8`, `ECHOK`, `IMAXBEL`) because `portable-pty` opens the PTY with NULL termios; without `IUTF8`, fish misbehaves.

### Persistence and profiles

`persistence.rs` saves the session/window/pane tree, layouts, names, active
indices, and last-known pane cwd to `$XDG_STATE_HOME/btmux/state.json` (falling
back to `$HOME/.local/state/btmux/state.json`). `--profile NAME` uses a separate
`<profile>/state.json` and token file. Running processes and scrollback are not
restored; restored panes spawn fresh shells lazily in their saved cwd. A
per-profile OS file lock prevents two btmux processes from owning the same
profile.

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
count), a `[terminal]` table of ghostty-web options, an optional `[log]` table,
and an inline `[theme]` base16/24 palette. `deny_unknown_fields` makes typos a
config error, so update `generate_config_toml` and tests when adding fields.

`[terminal]` mirrors ghostty-web's `ITerminalOptions` minus the runtime fields
(`cols`/`rows`/`ghostty`): `renderer`, `cursor-blink`, `cursor-style`, `scrollback`,
`font-size`, `font-family`, `font-weight`, `allow-transparency`, `convert-eol`,
`disable-stdin`, `smooth-scroll-duration`, and the btmux-specific
`scroll-sensitivity`. Keys are **kebab-case in TOML but camelCase on the wire**
— `TerminalOptions` uses `rename_all(serialize = "camelCase", deserialize = "kebab-case")`
so the same struct round-trips both ways. Unset fields serialize as `null`;
`TerminalPane.tsx` omits them so ghostty-web's own default applies.

`[theme]` is an inline base16 (`base00`–`base0F`) or base24 (adds `base10`–`base17`)
palette. `colors` may instead name a palette in the config colors directory, an
absolute or `~/`-relative YAML path, or an HTTP(S) YAML file; both top-level and
`palette`-wrapped documents are supported. An inline `[theme]` takes precedence.
`BaseTheme::to_theme`
translates it to ghostty-web's `ITheme` (fg/bg/cursor/
selection + 16 ANSI colors) using the canonical tinted-theming ANSI mapping. **base24
is auto-detected by the presence of all of `base10`–`base17`** (all-or-nothing; a
partial set falls back to base16); base24 then uses the dedicated bright slots
`base12`–`base17` instead of reusing the normal accents. The translation happens on
the **backend** — the browser receives a finished `ITheme`. Live reload updates renderer themes in place. Only construction-option changes
(fonts, renderer, scrollback, etc.) rebuild terminals; unrelated config changes
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
(command palette), `picker` (colors/fonts/shaders), or `confirm`. While an
overlay is open the keybinding hook early-returns so typing goes to the overlay,
not the terminal.

**Post-process shaders:** panes render through ghostty-web's
`renderer.setPostProcessShader` hook (WebGL only). `terminalFxShaders.ts` holds
every fragment shader plus two registries the frontend owns end-to-end — the
backend only stores the chosen id (`shader` / `session-view-shader` /
`pane-switch-shader`), and an unknown id falls back:

- `SHADER_EFFECTS` — _steady-state_ effects (`shader: choose effect`). The
  configured one is the **base state** of a pane's single post-process slot.
- `PANE_SWITCH_EFFECTS` — _one-shot_ effects played on the pane you switch to
  (`shader: choose pane-switch effect`, disabled by default).
  Each carries a `durationMs` that must cover its own timeline, since that's how
  long `TerminalPane` pumps frames before restoring the base effect.

`PANE_BORDER_STYLES` in `lib/paneSwitchBorder.ts` is a separate CSS/SVG
one-shot border draw controlled by `pane-switch-border` and
`pane-switch-border-speed`; it is independent of the WebGL pane-switch shader.
Unknown border IDs fall back in the frontend, and `animations = false` disables
both animated shader and border effects.

The session switcher's background panes can temporarily use any steady-state
effect via `session-view-shader` (unset by default). This uses the same
`SHADER_EFFECTS` registry and restores the pane's base shader when the switcher
closes. The key-help overlay retains its privacy pixelation.

Transient users of the slot (the pane-switch effect, session-view effect, and
`App.tsx`'s privacy pixelate) must hand it back via `baseShaderSrc()`
(`lib/baseShader.ts`) rather than `null`. Any `u_time`-driven shader also needs
`pumpRenders` — an idle terminal paints no frames, so animated effects freeze
without one.

**LaTeX overlay:** frontend-only. `lib/latexDetect.ts` is a pure, tiered
heuristic detector (explicit delimiters → bare `[`/`]` blocks → `$…$` → bare
`( … )`) tested by `frontend/latex-detect.test.ts`; add fixtures there when
tuning it. `lib/latexScan.ts` (`useLatexScan`) reads the viewport ± a margin from
the emulator buffer, debounced, and validates candidates with KaTeX, which is
lazy-loaded via `lib/katexRender.ts` on the first candidate. ghostty-web has no
output event (`onRender` never fires), so `TerminalPane` pokes the scanner after
each `term.write`. `toggle-latex` flips per-pane local UI state (`latexPanes` in
the store, not server state); `LatexOverlay.tsx` highlights source cells with
`term.setDecorations`, whose absolute buffer lines go stale on every rescan.

**Live config reload:** `main.rs` watches the config file's _parent dir_ with
`notify` (to catch editors' atomic rename-on-save), debounces, re-resolves, and
broadcasts a new `Config`. A parse error logs and **keeps the last good config**.

**Session-only overrides:** the command-palette pickers and settings appearance
overlay send `update_config` and **never touch config.toml**. They can override
the selected colors, fonts, animations, wallpapers, and shader/border settings.
`SessionManager` keeps the last-loaded `FileConfig` plus an accumulated
`ConfigUpdate` override layer, and `resolve_with_overrides` re-resolves the
`ClientConfig` from the two on every change. The overrides are for trying
settings out: they're dropped on restart and by `set_file_config`, i.e. on _any_
config-file reload. Persisting a setting is the user's job, by editing
config.toml. Anything added to the editor or pickers therefore needs a field in
`ConfigUpdate`, `ConfigUpdate::merge`, and `resolve_with_overrides`, plus the
generated protocol if the wire type changes.

## Asset embedding

`server.rs` uses `rust_embed` to compile `frontend/dist` into the binary at
build time. The binary serves the frontend from memory, so it works from any
working directory — no runtime dependency on the `frontend/dist` folder.

## Access boundary

Every backend route, WebSocket upgrade, and MCP call passes through `auth.rs`.
A profile's owner-only `state.token` contains its access credential, or
`BTMUX_AUTH_TOKEN` supplies one. Browsers use the token as their password; Vite's
frontend has an access-token form. Automation sends `Authorization: Bearer …`.
The token must be at least 32 URL-safe ASCII characters. Host and browser Origin
are checked against the local authority and explicit `--public-url` values;
forwarded headers do not grant trust.
PTY shells receive `BTMUX_AUTH_TOKEN` so generated notification hooks work.
`--public-url` adds explicit origins/authorities for Vite or a reverse proxy.
Never print credentials, put them in URLs, or bypass this middleware for new APIs.
Only one running server may own a persistence profile (held OS file lock).

Control commands may carry `request_id`; each gets a `command_result` with the
same id and an optional error, sent only to its originating socket. State remains
server-authoritative and shared, including active window/pane selection; session
navigation in the URL is per browser. Lagging control sockets resnapshot config
and state. Lagging PTY sockets disconnect and reconnect to a fresh replay.
