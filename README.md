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
- Split panes vertically and horizontally
- tmux-style keybindings, fully configurable
- Persistent scrollback, replayed on reconnect
- Hot config reload (theme, keybindings, terminal options)
- base16/base24 theme support
- REST API and MCP server for scripted/AI-agent control
- Claude Code hook integration (pane notifications for Stop, permission requests, etc.)

## Installation

### One-liner (macOS and Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

This downloads the latest release binary for your platform and places it in `~/.local/bin`.
Set `BTMUX_INSTALL_DIR` to override the install location.

### Run as a background service (optional)

btmux can register itself as a per-user background service so it starts at login and restarts on crash.
macOS uses a [launchd](https://www.launchd.info/) LaunchAgent; Linux uses a [systemd](https://systemd.io/) user unit.

```sh
btmux install              # install + start (defaults: 127.0.0.1:8004)
btmux --port 8004 install  # the host/port/shell you pass are baked into the service
btmux install --print      # print the generated service unit without installing
btmux uninstall            # stop + remove
```

The `--host`/`--port`/`--shell` flags (and your shell's `PATH`) are captured
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
btmux         # start the server (binds to localhost:8004 by default)
btmux --help  # get help
```

Navigate to `localhost:<port>`

Press `<prefix> + ?` to see a list of keybindings.

## Configuration

A default config file is created on first launch:

```
~/.config/btmux/config.toml
```

(respects `$XDG_CONFIG_HOME`).
All fields are optional and have sensible defaults.
Config changes are picked up live.

## Automation and AI agents

Everything below is served on the same host/port as the web UI (default
`localhost:8004`) — no separate process or port to run.

### REST API

Sessions, windows, and panes can be scripted over HTTP under `/api`:
create/rename/kill sessions and windows, split/kill/zoom panes, and send
input to / read output from a pane's shell.

```sh
curl -X POST localhost:8004/api/sessions -H 'Content-Type: application/json' -d '{"name":"build"}'
curl -X POST localhost:8004/api/panes/<pane-id>/input -H 'Content-Type: application/json' -d '{"text":"echo hi\n"}'
curl localhost:8004/api/panes/<pane-id>/output
```

There's no authentication — the API is only as safe as access to the port
itself, so keep btmux bound to `127.0.0.1` (the default) unless you know what
you're exposing.

### MCP server

btmux also exposes an [MCP](https://modelcontextprotocol.io) server at
`/mcp` on the same port, so an AI agent (e.g. Claude Code) can control
sessions, windows, and panes directly as tools instead of shelling out to
curl. It's a curated set of ~11 tools (`list_sessions`, `create_session`,
`split_pane`, `run_command`, `send_keys`, `read_pane_output`, ...) —
`run_command` sends a command to a pane and waits for its output to settle
before returning the (ANSI-stripped) result, so an agent gets something
close to a synchronous "run this and tell me what happened."

Register it with Claude Code:

```sh
claude mcp add --transport http btmux http://127.0.0.1:8004/mcp
```

Add `--scope user` to make it available in every project rather than just
the current one. The btmux server has to be running for tool calls to work —
this isn't a subprocess Claude Code spawns, it's routes on your existing
btmux server, so if you change `--port` you'll need to re-register with the
new URL. Verify it's connected with `claude mcp list`.

### Claude Code hook notifications

Every pane's shell gets `BTMUX_PANE_ID`/`BTMUX_API_URL` set automatically, so
a Claude Code instance running inside a btmux pane can report its own status
back to that pane — a colored dot / toast notification when it stops, needs
permission, fails, or finishes a task, visible even if you're looking at a
different pane or session.

[`extras/claude-code/hooks.json`](extras/claude-code/hooks.json) is a
ready-made hooks config covering `Stop`, `SubagentStop`, `StopFailure`,
`PermissionRequest`, `TaskCompleted`, and `Notification`. Merge its `hooks`
key into your `~/.claude/settings.json` (or a project's `.claude/settings.json`)
to enable it.

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
