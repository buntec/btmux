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
- `just vm <cmd>` — Ubuntu VM via Multipass (`scripts/vm.sh`, `scripts/vm-cloud-init.yaml`) for Linux testing and clean demos. `up` creates it; `deploy` builds this working tree in the VM, `release [TAG]` installs a release binary, and both (re)start btmux as a systemd user service on `0.0.0.0:8004` (in-place `btmux upgrade` when running); `info` prints the host-reachable URL and token; `demo` records `record-demo.ts` against it; `shell`, `stop`, `delete`.
- `just fmt` (alias `just format`) — format the whole codebase (`cargo fmt` + prettier). **Always run this before committing.**

`just test` runs the Rust regression suite. `just protocol` regenerates the frontend
wire types; the tests reject stale generated types. `just check` and `just lint`
remain required compilation/lint checks. `just test-browser` runs
`frontend/reliability-test.ts`, which exercises authentication, origin rejection,
reconnect/replay, config updates, correlated command errors, and multiple viewers,
followed by upgrade, Astryx interaction, theme, and Git checks
(`just test-nvim-browser` covers the Neovim surface; `just test-shader-browser`,
run on demand, the shader wallpapers). `frontend/browser-test-stack.ts`
gives each file a fresh stack (debug backend and Vite on free ports, a random token,
`/bin/sh`, temporary XDG and Git config), so a running `just dev`, user config, and
repo state don't affect it; failures keep the stack logs. Async page predicates must
use `waitForAsync` (`browser-test-utils.ts`): `page.waitForFunction` treats a
returned Promise as truthy and doesn't wait.
`just test-frontend` runs the frontend unit tests (`bun test`, the LaTeX detector and theme mapping). `just record-demo` drives the production UI with Playwright.

The CLI also accepts `--host`, `--port`, `--profile`, `--shell`, `--public-url`,
and `--no-browser`; `install`, `uninstall`, and `restart` manage a per-user
launchd/systemd service.

## Style guide

Keep code comments and git commit messages extremely concise.
Use American English consistently.

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

2. **`/ws/pane/{pane_id}?cols=&rows=`** (`src/ws/pane_io.rs`) — one socket **per visible pane**, carrying raw terminal bytes. Binary frames = PTY I/O; a JSON text frame `{type:"resize",cols,rows}` reports the viewer's size and `{type:"claim"}` makes it the size owner. The server sends `{type:"owner",owner}` before the replay and whenever ownership changes. On connect, a checkpoint and journal are replayed, followed by `ready`. The browser accepts input only after this initial replay completes.

   `?mirror=1` creates a read-only attachment for window-grid thumbnails. Mirrors receive output and ordered size frames but never resize or write to the PTY.

3. **`/ws/files`** (`src/ws/files.rs`) — correlated JSON request/response messages for the file browser. It supports directory/file metadata, tree and content search, rich previews, Git status/diff/stage/unstage/discard, rename, copy, move, trash, and delete. Opening a binary file (NUL or invalid UTF-8 in its first 8 KiB) runs `open`/`xdg-open` on the server host (`open_if_binary`) instead of the editor. `prefix + f` opens file mode; `prefix + g` opens Git mode. Git mode's magit-style popups (`b` branch, `f` fetch, `F` pull, `P` push, `z` stash) send `git_refs`/`git_run`; `file_git_ops.rs` maps a structured op to `git` CLI arguments (so credentials and hooks apply) and rejects option-like values. Keep filesystem access behind the authenticated route and preserve path validation in `fs_ops.rs`.

4. **`/ws/sysstat`** (`src/ws/sysstat.rs`) — emits one JSON frame per second with per-core CPU, memory, and aggregate network rates for the StatusBar. The frontend reconnects this auxiliary socket independently.

5. **`/ws/nvim`** (`src/ws/nvim.rs`) — a byte proxy between the browser and a new connection to the shared built-in Neovim's RPC socket. The browser speaks msgpack-RPC itself; see *Built-in Neovim* below.

REST handlers and MCP tools share the same `SessionManager`; structural mutations must call `broadcast_state` so browser tabs stay synchronized. REST lives under `/api` and includes session/window/pane/layout operations, pane input/output, notifications, and raw local-file serving. MCP is mounted at `/mcp`; tools cover session/window/pane lifecycle, `send_keys`, `read_pane_output`, and `run_command`. `run_command` appends Enter, captures ANSI-stripped output until 400 ms of quiet by default, and has a 15 s default timeout; quiet output does not prove process exit.

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
  Color queries (OSC 4/10/11/12, `CSI ? 996 n`) are answered the same way from the
  shared `pty/colors.rs` palette, overlaid with colors the program set in that
  pane (OSC 104/110–112 and RIS reset them; mixed set/query OSCs are split);
  `SessionManager::sync_palette` sends `CSI ? 997 ; Ps n` to panes that set
  mode 2031 when the theme changes. Replies are queued once per read and dropped
  if the input queue is full.
- **Termios** is set manually on the PTY master (`configure_termios`: `IUTF8`, `ECHOK`, `IMAXBEL`) because `portable-pty` opens the PTY with NULL termios; without `IUTF8`, fish misbehaves.

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
journals, title/cwd, program-set colors, any partly read escape sequence, and
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

### UI and theme

Astryx provides the app shell, navigation, forms, dialogs, tabs, and notifications.
Follow `frontend/AGENTS.md` and inspect component docs with `cd frontend && npx
astryx component <Name>`. `BtmuxTheme.tsx` derives the Astryx theme from the
resolved terminal palette and font family, including settings previews; semantic
colors and contrast belong in `lib/astryx-theme.ts`.

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
wterm keeps cell measurement private, so `measureCell()` reads its CSS cell
dimensions; the decoration overlay uses the same geometry. `open()` waits for
fonts before measuring, including for mirrors. Recheck measurement when bumping
`@wterm/*`.
Scrollback scrolls natively (`scrollTop` on the element); `PaneTerminal` throttles
application wheel input, delegates mouse encoding to wterm, and emits arrow keys
for alternate-screen programs without mouse tracking. Text and raw mouse input
share a byte callback. Theme, font, and
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
alpha, never the text's; 'pumblend' does the same for the popupmenu cards. Each
layer draws dirty rows to an offscreen canvas, and each flush composes it onto
the visible canvas with in-flight
`grid_scroll` animations (a snapshot of the region plus an eased pixel offset;
`[terminal] smooth-scroll-duration`, off with `animations = false`) and then
the cursor; layers with no dirty rows, scrolls, or cursor change are skipped. Unset `Normal` colors fall back to the btmux theme, as in a TUI,
and 'background' is set from the theme's luminance. 'guifont' (Neovide format,
`lib/nvimFont.ts`) and 'linespace' override the btmux terminal font. Keys go
through `lib/nvimKeys.ts` to `nvim_input`: F-keys and Cmd (`<D-…>`) reach
Neovim, except Cmd shortcuts the browser or desktop app keeps; the global
keybinding hook lets them through for the `data-nvim-input` textarea, which
follows the cursor so IME candidates and compositions appear there. Wheel steps
follow 'mousescroll'.
`lib/nvimWidgets.ts` reduces cmdline, popupmenu, and message events and
publishes them once per `flush`; `NvimWidgets.tsx` renders them as Astryx
components. Short messages (echo, `vim.notify`, errors) are expiring toasts;
multi-line output (`:ls`, `:!cmd`, `:messages`, prompts) is a panel the next
normal-mode key dismisses. Neovim never sends `msg_clear` in normal use, so
btmux owns dismissal.

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
sends without a path. `btmux open-editor [FILE] [LINE]` asks its pane's
server (`POST /api/panes/{id}/open-editor`): with `neovim` it opens the file
and broadcasts `open_nvim` to show the surface; otherwise, or outside btmux, it
execs `$EDITOR`.

### VS Code

With `editor = "vscode"`, `prefix + e` toggles VS Code over the active pane
(`VscodeSurface.tsx`), pinned and hidden by a double Esc like the Neovim
surface; only one of the two
covers a pane. `src/vscode.rs` lazily spawns one VS Code server per btmux
server, without a connection token, on a private Unix socket, and proxies
`/vscode/` (HTTP and WebSocket) to it behind `auth.rs`. `vscode-server`
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
Code: it reloads only when opened over a pane in another folder.

The extension in `extras/vscode` is embedded and installed into the profile's
extensions on each start, registered in VS Code's `extensions.json` (the
server ignores `--builtin-extensions-dir`) under a folder named with a hash of
its files, so any change makes VS Code rescan it. It connects back over
`BTMUX_VSCODE_SOCKET`, which carries newline-delimited JSON: `style` (the
base16/24 `color_palette` and the terminal font, on connect and on every
change) and `open`
(`editor = "vscode"`, `vscode_open`, `btmux open-editor`). The last open is
replayed to extension hosts that connect within 30 s, as VS Code may still be
starting or reloading. The extension writes the palette and font to user
settings (color customizations and the editor and integrated terminal font,
the editor at 80% size;
`btmux.syncTheme` and `btmux.syncFont` turn them off), which VS Code for the
web keeps in the browser. Bundled fonts are web fonts, so the surface copies
this page's `@font-face` rules into the iframe on each load. Change both sides
of this protocol together.

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
`font-weight`, `allow-transparency`, `disable-stdin`, `smooth-scroll-duration` (Neovim and file preview scrolling), and
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
so an effect processes every layer beneath it, and reconciles edits in place (unchanged
layers keep their simulation state). It adds runtime FPS, resolution, pause, seed, and
cursor controls. No terminal post-processing. `wallpaperCatalog.ts` resolves IDs and
kebab-case parameters. `just sync-shaders` regenerates parameter metadata and lazy loaders
from the pinned package (the `generators`/`effects` lists in `scripts/sync-shaders.mjs`);
`just test-frontend` checks that metadata is current. The session-only override replaces
the whole `wallpaper_shaders` stack. GPU failure leaves the theme background visible.
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
overlay send `update_config` and **never touch config.toml**. They can override
the appearance, color schemes, fonts, animations, wallpapers, and shader/border settings.
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
Never print credentials, put them in URLs, or bypass this middleware for new APIs.
Only one running server may own a persistence profile (held OS file lock).

Control commands may carry `request_id`; each gets a `command_result` with the
same id and an optional error, sent only to its originating socket. State remains
server-authoritative and shared, including active window/pane selection; session
navigation in the URL is per browser. Lagging control sockets resnapshot config
and state. Lagging PTY sockets disconnect and reconnect to a fresh replay.
