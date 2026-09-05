# Automation and AI agents

The REST API, MCP server, and web UI share the same host and port (by default,
`127.0.0.1:8004`). No separate process is required.

> [!WARNING]
> These interfaces have no separate authentication boundary. Anyone who can
> reach the btmux port can control shells and access files available to the
> btmux user.

## REST API

Sessions, windows, and panes can be controlled over HTTP under `/api`.

```sh
curl -X POST localhost:8004/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"build"}'

curl -X POST localhost:8004/api/panes/<pane-id>/input \
  -H 'Content-Type: application/json' \
  -d '{"text":"echo hi\n"}'

curl localhost:8004/api/panes/<pane-id>/output
```

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
| `POST /api/panes/<pane-id>/input`                               | Send text to a pane, spawning its shell if necessary      |
| `GET /api/panes/<pane-id>/output`                               | Read scrollback bytes, including ANSI escapes             |
| `POST/DELETE /api/panes/<pane-id>/notify`                       | Set or clear an agent notification                        |

## MCP server

The MCP server at `/mcp` exposes tools for creating and inspecting sessions,
splitting panes, running commands, sending keys, and reading pane output.

`run_command` waits until output has been idle for 400 ms by default, then
returns an ANSI-stripped result. This does not prove that the process exited: a
quiet, long-running command can return early. The overall timeout defaults to
15 seconds, and callers can adjust both intervals or follow up with
`read_pane_output`.

Register the server with Claude Code:

```sh
claude mcp add --transport http btmux http://127.0.0.1:8004/mcp
claude mcp list
```

Add `--scope user` to the first command to make it available in every project.
The btmux server must already be running. Re-register the URL if you change its
port.

## Agent hook notifications

Each pane's shell receives `BTMUX_PANE_ID` and `BTMUX_API_URL`. An agent harness
running in the pane can use them to display a colored dot or toast when it
stops, needs permission, fails, or finishes work—even when another pane or
session is active.

Generate ready-to-paste hook configuration with:

```sh
btmux generate-claude-code-hooks  # merge hooks into ~/.claude/settings.json
btmux generate-codex-hooks        # merge hooks into ~/.codex/hooks.json
btmux generate-gemini-cli-hooks   # merge hooks into ~/.gemini/settings.json
```

The same snippets are available in [`extras/`](../extras/). Other command-hook
harnesses can pipe their JSON hook payload to:

```sh
$BTMUX_API_URL/api/panes/$BTMUX_PANE_ID/notify
```

[Back to the README](../README.md)
