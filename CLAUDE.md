# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

btmux is a browser-based tmux. A Rust/axum backend owns real PTYs and the
session/window/pane tree; a React + TypeScript frontend renders panes with the
`ghostty-web` WASM terminal emulator and talks to the backend over two
WebSocket channels.

## Commands

The `justfile` is the source of truth (`just` lists all recipes). Common ones:

- `just dev` — run backend (port 8044) and frontend (Vite, port 5173) together. **Develop against http://localhost:5173**; Vite proxies `/ws` and `/api` to 8044. The dev backend uses 8044 (not the production default 8004) so it doesn't collide with a running production/service instance; the port lives in the `dev_port` justfile var and is mirrored in `vite.config.ts`.
- `just dev-backend` / `just dev-frontend` — run one side only.
- `just check` — `cargo check` + `tsc --noEmit` (fast, run this before claiming a change compiles).
- `just lint` — `cargo clippy -- -D warnings` (warnings are errors).
- `just build` — production build: frontend → `frontend/dist`, then `cargo build --release`.
- `just run` — release binary serving the built frontend.
- `just install` — production build + `cargo install --path .`

There is **no test suite**. `cargo check`, `cargo clippy`, and `tsc --noEmit` are the only automated verification.

## Architecture

### Server-authoritative state

All session structure lives on the backend in `SessionManager`, held as
`Arc<RwLock<SessionManager>>` (aliased `AppState` in `main.rs`). The frontend
holds **no canonical state** — it renders whatever the server pushes. A single
default session ("0") is created at startup; sessions/windows/panes are then
created, switched, renamed, and killed via control commands.

### Two WebSocket channels (the core split)

1. **`/ws/control`** (`src/ws/control.rs`) — JSON command channel for structural changes (pane split/kill/navigate/zoom, window create/switch/rename/close, session create/switch/select/rename/kill). Each command mutates `SessionManager` and the server **broadcasts** the result. The client never mutates layout locally; it waits for the push. Auto-reconnects every 2s (`useControlSocket.ts`).

   **Broadcast fan-out:** `SessionManager` owns a `tokio::sync::broadcast::Sender<String>` (`events()`) carrying pre-serialized `ServerMessage` JSON. Every control socket spawns a forward task (`receiver → ws_tx`), so a mutation in one browser tab — or a config reload — reaches *all* tabs. On connect a socket is also sent its current `Config` + `State` directly so it doesn't wait for the next event. Two `ServerMessage` variants: `State { sessions, all_sessions }` (`Vec<SessionSummary>` for the StatusBar/picker + `Vec<SessionSnapshot>` with full window/layout data) and `Config { config }`.

2. **`/ws/pane/{pane_id}?cols=&rows=`** (`src/ws/pane_io.rs`) — one socket **per visible pane**, carrying raw terminal bytes. Binary frames = PTY I/O; a JSON text frame `{type:"resize",cols,rows}` resizes. On connect, the pane's scrollback buffer is replayed so reconnecting/re-mounting shows existing content.

### PTY lifecycle (`src/pty/mod.rs`)

- A `PtyHandle` is created when a pane is created but the shell is **lazily spawned** on first `/ws/pane` connection (`ensure_spawned`), using the cols/rows from the query string.
- Output fans out via a `tokio::sync::broadcast` channel, so multiple browser tabs can attach to the same pane. The last 64 KB is kept in a `scrollback` buffer for replay.
- **DA1/DA2 query interception** (`strip_and_answer_da_queries`): the reader thread intercepts `ESC[c` / `ESC[>c`, injects canned responses back into the PTY input, **and strips the query bytes from the output stream**. `ghostty-web` *also* answers DA (and DSR), but btmux is one PTY fanned out to many emulators — letting the emulator answer would hang detached panes (no emulator attached), duplicate the reply once per attached tab (the extra leaks to the shell and gets echoed, e.g. `^[[?62;22c`), and re-answer stale queries on scrollback replay. Stripping makes the backend the single responder. The canned bytes mirror `ghostty-web`'s exact DA replies for the pinned build — re-probe if `ghostty-web` is bumped. Don't remove this without a replacement.
- **Termios** is set manually on the PTY master (`configure_termios`: `IUTF8`, `ECHOK`, `IMAXBEL`) because `portable-pty` opens the PTY with NULL termios; without `IUTF8`, fish misbehaves.

### Layout tree — the shared contract

`Layout` (`src/session/layout.rs`) is a recursive binary tree:
`Leaf` / `VSplit` / `HSplit`. It is serialized with serde `tag = "type"`,
`rename_all = "snake_case"`, and the frontend's `LayoutNode`
(`frontend/src/state/types.ts`) plus `computeRectsAndDividers` in
`frontend/src/state/layout.ts` decode it into percentage-based rects. **If you change the Rust `Layout` enum or any
`*Snapshot` struct, update the matching TypeScript types and the
`ClientMessage`/`ServerMessage` unions together** — they are hand-mirrored, not
generated.

### Protocol magic numbers

Both `switch_window` and `switch_session` use sentinel indices: `-1` = next,
`-2` = prev, `>=0` = absolute. Resolved by the shared `resolve_index` helper in
`manager.rs`; the senders live in `useKeybindings.ts`. Keep them in sync.

### Config + keybindings (the data-driven keymap)

Config is a TOML file at `$XDG_CONFIG_HOME/btmux/config.toml` (falling back to
`$HOME/.config/btmux/config.toml`), parsed in `src/config.rs`. All fields
optional: `prefix` (tmux-style, e.g. `"C-a"`), `shell` (CLI `--shell` still wins),
a `[keys]` table mapping **action name → key** to override defaults, a `[terminal]`
table of ghostty-web options, and an inline `[theme]` base16/24 palette.

`[terminal]` mirrors ghostty-web's `ITerminalOptions` minus the runtime fields
(`cols`/`rows`/`ghostty`): `cursor-blink`, `cursor-style`, `scrollback`,
`font-size`, `font-family`, `allow-transparency`, `convert-eol`, `disable-stdin`,
`smooth-scroll-duration`. Keys are **kebab-case in TOML but camelCase on the wire**
— `TerminalOptions` uses `rename_all(serialize = "camelCase", deserialize = "kebab-case")`
so the same struct round-trips both ways. Unset fields serialize as `null`;
`TerminalPane.tsx` omits them so ghostty-web's own default applies.

`[theme]` is an inline base16 (`base00`–`base0F`) or base24 (adds `base10`–`base17`)
palette. `BaseTheme::to_theme` translates it to ghostty-web's `ITheme` (fg/bg/cursor/
selection + 16 ANSI colors) using the canonical tinted-theming ANSI mapping. **base24
is auto-detected by the presence of all of `base10`–`base17`** (all-or-nothing; a
partial set falls back to base16); base24 then uses the dedicated bright slots
`base12`–`base17` instead of reusing the normal accents. The translation happens on
the **backend** — the browser receives a finished `ITheme`. Changing the `[theme]`
or `[terminal]` table triggers a live reload that re-themes existing panes (the
`termOptions`-keyed effect in `TerminalPane.tsx` rebuilds the `Terminal`; the pane
socket replays scrollback so content survives).

`config.rs` is the **single source of truth for keybindings**: `DEFAULT_BINDS`
holds the tmux-style defaults, `resolve_binds` merges `[keys]` overrides over them,
and the resulting `ClientConfig { prefix, binds: [{key, action}] }` is serialized to
the browser. Actions are kebab-case strings (`split-vertical`, `new-session`, …),
each mapping 1:1 to a case in `runAction` (`useKeybindings.ts`). **To add a binding
you must touch both:** add the default in `config.rs` and the handler case in
`useKeybindings.ts`. `0-9` window-select is special-cased in the frontend, not in
the bind table.

`useKeybindings.ts` parses the configured prefix (modifiers `C-`/`M-`/`S-` + key),
captures keys in the capture phase, and on the second keystroke either sends a
`ClientMessage` or opens an **overlay** (`components/Overlay.tsx`): `prompt`
(rename window/session, new session), `keys` (keybinding help), `command`
(command palette), or `confirm`. While an overlay is open the keybinding hook
early-returns so typing goes to the overlay, not the terminal.

**Live config reload:** `main.rs` watches the config file's *parent dir* with
`notify` (to catch editors' atomic rename-on-save), debounces, re-resolves, and
broadcasts a new `Config`. A parse error logs and **keeps the last good config**.

## Asset embedding

`server.rs` uses `rust_embed` to compile `frontend/dist` into the binary at
build time. The binary serves the frontend from memory, so it works from any
working directory — no runtime dependency on the `frontend/dist` folder.
