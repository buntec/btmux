---
name: btmux
description: Control btmux, a browser-based tmux, from the shell. Use when running inside btmux ($BTMUX_PANE_ID is set) or when asked to work with btmux sessions, windows, or panes, for example to run a dev server or tests in a separate pane, read another pane's output, notify the user, or start and coordinate other coding agents.
---

# btmux

btmux is a tmux-like terminal multiplexer whose panes the user sees in a
browser. The `btmux` CLI talks to the running server. Inside a btmux pane,
`$BTMUX_PANE_ID` is your pane's ID and commands reach this server without
setup; outside one, they use the default server (or `--profile NAME`).

The commands mirror tmux, so use what you know from tmux, except for the
differences below. `btmux <command> --help` lists each command's flags.

## Panes, windows, sessions

```sh
btmux list-panes -F '#{pane_index} #{pane_id} #{pane_active} #{pane_current_path}'
btmux list-panes -a          # every pane, as JSON
btmux list-windows -a -F '#{session_name}:#{window_index} #{window_name}'
btmux list-sessions
```

`-t` takes a pane, window, or session ID, or `SESSION[:WINDOW[.PANE]]` by name
or index (`work:1.0`, `:2` for window 2 of this session, `:.1` for pane 1 of
this window). Without `-t`, the target is your own pane. Prefer pane IDs: they
stay valid when panes move or other panes close.

`new-session`, `new-window`, and `split-window` print the new pane's ID:

```sh
pane=$(btmux split-window -h -d -c "$PWD")     # side by side, keep focus here
win=$(btmux new-window -d -n server -c "$PWD") # background window
btmux kill-pane -t "$pane"
```

Pass `-d` so you don't move the user's focus, and `-c "$PWD"` so the shell
starts in your directory. The last pane of a window closes the window, and the
last window closes the session.

Other commands: `kill-window`, `kill-session`, `select-pane`, `select-window`,
`rename-window`, `rename-session`.

## Typing and reading

```sh
btmux send-keys -t "$pane" 'npm run dev' Enter
btmux send-keys -t "$pane" C-c
btmux send-keys -t "$pane" -l 'text sent as is, even Enter'
btmux capture-pane -p -t "$pane"            # the visible screen
btmux capture-pane -p -t "$pane" -S -200    # plus 200 rows of history
btmux capture-pane -p -t "$pane" -S -       # all retained history
```

Each `send-keys` argument is a key name (`Enter`, `Tab`, `Escape`, `C-c`,
`M-x`, `Up`, `PageDown`, `F5`) if it is one, else literal text; arguments are
joined without spaces and nothing adds Enter. `capture-pane` prints plain text
with wrapped lines joined. Output arrives asynchronously: after sending a
command, poll `capture-pane` until its result or the next prompt appears rather
than assuming it finished.

## Other agents

```sh
btmux agents                          # panes running an agent, with their states, as JSON
btmux wait "$pane"                    # until it is idle, done, or blocked
btmux wait "$pane" --state done --timeout 1800
```

States are `working`, `blocked` (waiting for approval or input), `done`
(finished a turn), `idle`, and `unknown`. `--timeout` is in seconds (default
600, at most 3600); `btmux wait` exits 2 on timeout.

To give an agent a prompt, use `btmux prompt` instead of `send-keys`: it
pastes the text, presses Enter reliably, waits for the turn to finish, and
prints the agent's state and rendered screen as JSON. It exits 2 on timeout.
The status `message` is only the first line of the agent's last reply; read
`screen`, or have the agent write longer results to a file.

```sh
btmux prompt "$pane" 'Run the tests and fix any failures.'
btmux prompt "$pane" < task.md                 # prompt from stdin
btmux prompt "$pane" --no-wait 'Also update the docs.'
```

It refuses while the agent is `blocked` (read the pane and answer with
`send-keys`) and, unless `--no-wait`, while it is `working`.

To start an agent, launch it in a new pane with `send-keys`, then `btmux wait`
for it before prompting. To stop one, kill its pane.

## Notifying the user

```sh
btmux send-notification 'Tests passed' --body '42 passed' --level success
```

Levels are `info`, `attention`, `success`, and `error`.

## Etiquette

- The panes are the user's. Don't type into, kill, or rename panes you didn't
  create unless asked; read them freely.
- Clean up panes and windows you created when you are done with them, unless
  the user wants them kept (for example a running dev server).
- Never print or log `$BTMUX_AUTH_TOKEN`.
