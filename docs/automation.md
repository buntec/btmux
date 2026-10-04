# Automation and AI agents

The REST API, MCP server, and web UI share the same host and port (by default,
`127.0.0.1:8004`). No separate process is required.

## Authentication

All HTTP and MCP calls require the instance's access token. Inside a btmux pane,
`BTMUX_AUTH_TOKEN` is already set. Outside a pane, load the default instance's
token before running the examples below:

```sh
export BTMUX_AUTH_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token")"
```

For a named profile or development instance, use its
[profile-specific token file](installation.md#first-sign-in). If the server was
started with `BTMUX_AUTH_TOKEN` set, use that value instead.

Send `Authorization: Bearer $BTMUX_AUTH_TOKEN` with every request. Existing MCP
client configurations and previously installed hook snippets also need this
header. The token grants control of shells and access to files available to
the btmux user.

## REST API

Sessions, windows, and panes can be controlled over HTTP under `/api`.

```sh
curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" -X POST http://127.0.0.1:8004/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"build"}'

curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" -X POST http://127.0.0.1:8004/api/panes/<pane-id>/input \
  -H 'Content-Type: application/json' \
  -d '{"text":"echo hi\n"}'

curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" http://127.0.0.1:8004/api/panes/<pane-id>/output

curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" -X POST http://127.0.0.1:8004/api/panes/<pane-id>/open-file-browser \
  -H 'Content-Type: application/json' \
  -d '{"path":"/home/user/project","mode":"files"}'
```

`open-file-browser`'s `mode` is `"files"` (default), `"git"`, or `"process"`,
matching the `prefix + f` / `prefix + g` / `prefix + t` overlay. It switches
every connected browser tab
to the pane's window and session before opening the overlay there.
For file mode, optional `focus_file` names an entry in `path` to focus on open.

When Neovim owns the pane's terminal, selecting a file opens it in that
instance through its RPC server. If the server is unavailable, the browser
shows an error. Otherwise, selecting a file runs `$EDITOR` only if the pane's
shell owns the terminal. If another program is in the foreground, the browser
shows an error and leaves that program's input untouched.

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
| `POST/DELETE /api/panes/<pane-id>/notify`                       | Report agent events or set/clear a notification            |
| `POST /api/panes/<pane-id>/open-file-browser`                   | Open the file browser at a path, in the pane's session     |
| `GET/POST/DELETE /api/panes/<pane-id>/agent-status`                 | Explain, set, or clear semantic agent status                       |

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
claude mcp add --transport http btmux http://127.0.0.1:8004/mcp \
  --header "Authorization: Bearer ${BTMUX_AUTH_TOKEN}"
claude mcp list
```

Add `--scope user` to the first command to make it available in every project.
The btmux server must already be running. Re-register the server if you change
its port or token.

## Semantic agent status

Agent integrations can report a live lifecycle state independently from
notifications:

```sh
curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" \
  -X POST "${BTMUX_API_URL}/api/panes/${BTMUX_PANE_ID}/agent-status" \
  -H 'Content-Type: application/json' \
  -d '{"state":"working","agent":"codex","source":"hook"}'
```

The supported states are `unknown`, `idle`, `working`, `blocked`, and `done`.
`done` becomes `idle` when the pane is viewed. A tool completion or new turn
moves a blocked agent back to `working`; terminal input alone does not prove
that an approval was resolved. The existing `/notify` endpoint maps known hook
events to these transitions. Intermediate `TaskCompleted` events only notify;
they do not mark the whole turn done.

Use `DELETE` on the same endpoint when the reporter no longer knows which agent
is in the pane. Detected processes stay in the agent grid even when their
activity is `unknown`; explicit reports without a process need another state. Status is broadcast through the normal server-authoritative state snapshot,
so all connected browser tabs see the same value. Status resets when btmux
restarts. Explicit reports without a process identity expire after 12 hours
unless renewed.

## Agent hook notifications

Each pane's shell receives `BTMUX_PANE_ID`, `BTMUX_API_URL`, and `BTMUX_AUTH_TOKEN`. An agent harness
running in the pane can use them to display a colored dot or toast when it
stops, needs permission, fails, or finishes work—even when another pane or
session is active.

btmux detects interactive Codex, Claude Code, and Gemini CLI processes under each
pane's shell, including known Node/Bun entry points. It checks process identity
roughly every second and uses the foreground job to select the agent whose
screen it reads. A confirmed process exit clears status even when Ctrl-C skips
the end hook. Suspended or background agents remain present with unknown activity.
When another agent takes the foreground, a suspended agent keeps its hook session
and resumes it after `fg`.
Press `prefix + a` to open the agent grid.

While a pane has a detected agent, the backend reconstructs its live terminal
screen from ordered PTY output and resize events, independently of browser
viewers. Tracking starts from the replay checkpoint and journal, so panes without
an agent pay no parsing cost. About every
300 ms, it evaluates bundled TOML manifests against the screen and OSC title and
progress signals. Rules recognize working indicators, approval dialogs, and idle
prompts. They scope matches to the current UI to avoid old transcript text.
Screen-only working/blocked transitions to idle or unknown settle for 700 ms to
avoid redraw flicker. Missing indicators do not prove completion: only
completion reports set `done`, and idle screens do not acknowledge it.

When hooks and screens disagree, the more reliable evidence wins:

1. `POST /agent-status` reports are reporter-controlled; screen detection never
   overrides them.
2. Hook reports outrank screens. A hook ignores screen evidence produced before
   it. An unmatched or `unknown` screen never overrides a hook, and a screen that
   agrees keeps the hook's source and message.
3. A matched screen rule that contradicts a hook for 1.5 s wins, which corrects
   missed hooks such as an interrupt without `Stop`. The next hook takes over again.
4. Process presence alone reports `unknown` activity.

Hooks may report a wrapper's child process; the process scan's own choice
identifies the agent and selects its manifest. Names reported by hooks take
precedence over process names. A newly detected agent ignores OSC titles that a
previous program left behind.

The generated hooks remain useful for session/turn identities, completion
messages, and notifications. Reinstall older hook snippets to receive those
reports. Agent status is runtime-only and resets when btmux restarts.

### Detection manifests and diagnostics

The bundled rules are adapted from Herdr revision
`5da0a01e1eedda054db0c81dd3a780000c40d9f0`; attribution and the upstream license
live in `third-party/herdr`. Codex's generic title-idle rule is omitted: an ordinary
title or composer does not establish that a turn ended. Unmatched screens produce
unknown activity rather than an inferred successful completion.

Local overrides replace each agent's bundled manifest:

```text
~/.config/btmux/agent-detection/claude.toml
~/.config/btmux/agent-detection/codex.toml
~/.config/btmux/agent-detection/gemini.toml
```

The directory follows `XDG_CONFIG_HOME`, like `config.toml`. Edits are checked
every five seconds. Invalid overrides log a warning and fall back to bundled
rules. Rules support priorities, scoped regions, `contains` (case-insensitive),
`regex`, per-line `line_regex`, nested `all`/`any`/`not`, visible evidence flags,
and `skip_state_update` for transcript viewers. Engine versions through 3 are
supported. Manifests are local; btmux does not fetch remote rule updates.

For example, a custom Codex approval rule:

```toml
id = "codex"
version = "local.1"
min_engine_version = 3

[[rules]]
id = "custom_approval"
state = "blocked"
priority = 900
region = "after_last_prompt_marker"
visible_blocker = true
contains = ["enter to approve", "esc to cancel"]
```

Inspect status and detection evidence through the authenticated REST API:

```sh
curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" \
  "${BTMUX_API_URL}/api/panes/${BTMUX_PANE_ID}/agent-status"
```

The response includes `status`, the `authority` that set it (`explicit`, `hook`,
`screen`, or `process`), tracked `process` identity, and the most recent
`detection`: matched rule, region, priority, manifest version/source, screen
revision, and visible evidence flags. It excludes terminal contents. A null rule
means no rule matched; a null detection means no screen evaluation is available.

Print ready-to-paste hook configuration with:

```sh
btmux generate-claude-code-hooks  # print JSON; merge it into ~/.claude/settings.json
btmux generate-codex-hooks        # print JSON; merge it into ~/.codex/hooks.json
btmux generate-gemini-cli-hooks   # print JSON; merge it into ~/.gemini/settings.json
```

Or install the hooks directly into the per-user config files while preserving
other settings and hook entries:

```sh
btmux install-claude-code-hooks
btmux install-codex-hooks
btmux install-gemini-cli-hooks
```

The Codex installer uses `$CODEX_HOME/hooks.json` when `CODEX_HOME` is set,
otherwise `~/.codex/hooks.json`.

The same snippets are available in [`extras/`](../extras/). Other command-hook
harnesses can POST their JSON hook payload to the authenticated endpoint:

```sh
curl -H "Authorization: Bearer $BTMUX_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST --data-binary @- \
  "$BTMUX_API_URL/api/panes/$BTMUX_PANE_ID/notify"
```

[Back to the README](../README.md)
