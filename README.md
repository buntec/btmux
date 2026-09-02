# btmux

A browser-based terminal manager with tmux-inspired UI, powered by [ghostty-web](https://github.com/coder/ghostty-web).
(Actually, this [fork](https://github.com/rcarmo/ghostty-web).)

## Why in the browser

Why run another app when your browser is already running?

## Why not just tmux?

- https://github.com/kovidgoyal/kitty/issues/391#issuecomment-638320745
- https://hachyderm.io/@mitchellh/116223923635216562

## Features

- Multiple sessions, windows and panes
- Vertical/horizontal splits, pane zoom, pane swapping and preset layouts
- Configurable tmux-style action bindings, including optional vi-style navigation
- Configurable in-memory scrollback, replayed when a browser reconnects
- Searchable session tree, session switcher and live window-grid thumbnails
- Keyboard-driven file browser with previews, filename/content search and Git operations
- Hot config reload (theme, keybindings, terminal options)
- base16/base24 theme support
- Bundled fonts, appearance editor, wallpapers and WebGL terminal effects
- Host CPU, memory and network statistics in the status bar
- REST API and MCP server for scripted/AI-agent control
- Agent hook integrations (pane notifications for completed turns, permission requests, etc.)

## Demo

https://github.com/user-attachments/assets/5fade3d9-9ee1-49ae-9460-16a15a0ec49a

## Installation

### One-liner (Apple Silicon macOS and Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

This downloads the latest release binary for your platform and places it in `~/.local/bin`.
Set `BTMUX_INSTALL_DIR` to override the install location.
Release binaries are provided for Apple Silicon macOS and x86-64/ARM64 Linux;
Intel macOS is not currently supported by the installer.

### Run btmux as a background service (recommended)

btmux can register itself as a per-user background service so it starts at login and restarts on crash.
macOS uses a [launchd](https://www.launchd.info/) LaunchAgent; Linux uses a [systemd](https://systemd.io/) user unit.

```sh
btmux install              # install + start (defaults: 127.0.0.1:8004)
btmux --port 8004 install  # the host/port/shell you pass are baked into the service
btmux install --print      # print the generated service unit without installing
btmux restart              # restart the installed service
btmux uninstall            # stop + remove
```

The `--host`/`--port`/`--profile`/`--shell` flags (and your shell's `PATH`) are captured
into the generated unit at install time, so re-run the installer after changing
any of them. Install from a stable binary path (e.g. `~/.local/bin/btmux`), not a
`target/` build artifact — a rebuild or `cargo clean` would break the service.

### Build from source

Clone this repo.

```sh
just setup
cargo install --path .
```

## Use

```sh
btmux                   # start the server and open it in a browser
btmux --no-browser      # start without opening a browser tab
btmux --help            # show all flags and subcommands
btmux version           # print the installed version
btmux generate-config   # print a documented default config.toml
```

By default, session structure is persisted in
`~/.local/state/btmux/state.json` (respecting `$XDG_STATE_HOME`). Use a named
profile to run isolated btmux instances; each profile has its own session
state under `$XDG_STATE_HOME/btmux/<profile>/state.json`, falling back to
`~/.local/state/btmux/<profile>/state.json`:

```sh
btmux --profile work --port 8005
btmux --profile personal --port 8006
```

Without `--profile`, btmux continues to use the top-level `state.json`.

Persistence covers the session/window/pane tree, layout, names, active indices
and each pane's last-known working directory. It does **not** preserve running
shell processes or scrollback across a btmux restart: restored panes start fresh
shells lazily in their saved working directories.

Navigate to `http://localhost:<port>`.

Press `<prefix> + ?` to see a list of keybindings.

btmux has no authentication on any route. Anyone who can reach its port can
control shells and sessions through WebSockets, REST or MCP, and can use the
file browser to read and modify files available to the btmux user. Keep it bound
to `127.0.0.1` (the default) unless you put an appropriate authenticated,
encrypted access layer in front of it.

## Configuration

A default config file is created on first launch:

```
~/.config/btmux/config.toml
```

(respects `$XDG_CONFIG_HOME`).
All fields are optional and have sensible defaults.
Config changes are picked up live.

Press `<prefix> + :` and choose `config: open appearance settings` to open the
browser-based appearance editor. Its Apply button creates process-local preview
overrides; it never writes `config.toml`. These overrides affect connected
clients and are discarded when btmux restarts or whenever `config.toml` reloads.
Use the editor's generated TOML/copy action to persist settings yourself.

The configuration also supports session/window sort order, pane title bars,
vi-style navigation, bundled font family/weight selection, image or procedural
wallpapers, and steady-state/session-switch/pane-switch WebGL effects. Run
`btmux generate-config` for the complete documented set of options.

`colors` accepts either the name of a base16/base24 YAML file in
`~/.config/btmux/colors/` or an `http://`/`https://` URL to one. YAML palettes
may be at the top level or nested under `palette`; remote files are fetched
when the config is loaded and reloaded.

## Automation and AI agents

Everything below is served on the same host/port as the web UI (default
`localhost:8004`) — no separate process or port to run.

### REST API

Sessions, windows, and panes can be scripted over HTTP under `/api`:
create, inspect, rename and kill sessions/windows; split, select, navigate, swap,
zoom and rearrange panes; and send input to or read output from a pane's shell.

```sh
curl -X POST localhost:8004/api/sessions -H 'Content-Type: application/json' -d '{"name":"build"}'
curl -X POST localhost:8004/api/panes/<pane-id>/input -H 'Content-Type: application/json' -d '{"text":"echo hi\n"}'
curl localhost:8004/api/panes/<pane-id>/output
```

The main endpoint groups are:

| Method and path                                                 | Purpose                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| `GET/POST/DELETE /api/sessions`                                 | List, create, or clear sessions                           |
| `GET/DELETE /api/sessions/<session-id>`                         | Inspect or kill a session                                 |
| `POST /api/sessions/<session-id>/rename`                        | Rename a session                                          |
| `POST /api/sessions/<session-id>/windows`                       | Create a window                                           |
| `POST /api/sessions/<session-id>/windows/{switch,rename,close}` | Operate on a session's active window                      |
| `DELETE /api/windows/<window-id>`                               | Kill a window by ID                                       |
| `POST/DELETE /api/sessions/<session-id>/panes/...`              | Split, kill, select, navigate, cycle, swap, or zoom panes |
| `POST /api/sessions/<session-id>/layout`                        | Select a named pane layout                                |
| `POST /api/sessions/<session-id>/layout/next`                   | Cycle to the next pane layout                             |
| `POST /api/panes/<pane-id>/input`                               | Send raw text to a pane, spawning its shell if necessary  |
| `GET /api/panes/<pane-id>/output`                               | Read raw scrollback bytes, including ANSI escapes         |
| `POST/DELETE /api/panes/<pane-id>/notify`                       | Set or clear an agent notification                        |

There is no separate authentication boundary for the API; the security warning
in [Use](#use) applies to every endpoint on the btmux port.

### MCP server

btmux also exposes an [MCP](https://modelcontextprotocol.io) server at
`/mcp` on the same port, so an AI agent (e.g. Claude Code) can control
sessions, windows, and panes directly as tools instead of shelling out to
curl. It's a curated set of 11 tools (`list_sessions`, `create_session`,
`split_pane`, `run_command`, `send_keys`, `read_pane_output`, ...) —
`run_command` sends a command to a pane and waits for its output to settle
before returning the (ANSI-stripped) result, so an agent gets something
close to a synchronous "run this and tell me what happened." Settled means that
the pane produced no new output for the idle interval (400 ms by default), not
that the process is known to have exited. A quiet long-running command can
therefore return early; the overall timeout defaults to 15 seconds, and callers
can adjust both intervals or follow up with `read_pane_output`.

Register it with Claude Code:

```sh
claude mcp add --transport http btmux http://127.0.0.1:8004/mcp
```

Add `--scope user` to make it available in every project rather than just
the current one. The btmux server has to be running for tool calls to work —
this isn't a subprocess Claude Code spawns, it's routes on your existing
btmux server, so if you change `--port` you'll need to re-register with the
new URL. Verify it's connected with `claude mcp list`.

### Agent hook notifications

Every pane's shell gets `BTMUX_PANE_ID`/`BTMUX_API_URL` set automatically, so
an agent harness running inside a btmux pane can report its own status back to
that pane — a colored dot / toast notification when it stops, needs permission,
fails, or finishes a task, visible even if you're looking at a different pane or
session.

btmux prints ready-to-paste hook configuration for popular harnesses:

```sh
btmux generate-claude-code-hooks  # merge `hooks` into ~/.claude/settings.json
btmux generate-codex-hooks        # merge `hooks` into ~/.codex/hooks.json
btmux generate-gemini-cli-hooks   # merge `hooks` into ~/.gemini/settings.json
```

The same snippets live under [`extras/`](extras/) for reference. The
notification endpoint accepts the harness's JSON hook payload directly, so
other command-hook harnesses can use the same pattern: pipe hook stdin to
`$BTMUX_API_URL/api/panes/$BTMUX_PANE_ID/notify`.

## Development

Requires [Rust](https://rustup.rs) and [Bun](https://bun.sh).

```sh
just setup  # install dependencies
just dev    # backend on :8044, frontend on :5173 (open http://localhost:5173)
just build  # production build
just run    # serve production build on :8004
```

## License

[MIT](LICENSE)
