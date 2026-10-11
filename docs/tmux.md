# btmux for tmux users

The default prefix is `C-b` and most default keys match tmux. Press
`<prefix> + ?` for the live list. This page covers where btmux differs.

## Same as tmux

`%` `"` split, `x` kill pane, `z` zoom, `o` next pane, `;` last pane, `{` `}`
swap pane, `Space` next layout, `q` pane numbers, arrows navigate, `c` new
window, `n` `p` `l` window next/prev/last, `0`-`9` select window, `,` rename
window, `&` kill window, `$` rename session, `(` `)` previous/next session, `L`
last session, `[` capture scrollback, `/` search, `]` paste, `?` key list, `:` prompt.

## Same key, different meaning

| Key     | tmux        | btmux                                             |
| ------- | ----------- | ------------------------------------------------- |
| `w`     | choose-tree | window grid (live thumbnails)                     |
| `s`     | choose-tree | session/window switcher                           |
| `t`     | clock       | process view                                      |
| `f`     | find-window | file browser                                      |
| `m`     | mark pane   | LaTeX overlay                                     |
| `C`     | (unbound)   | new session (prompts for name)                    |
| `g` `a` | (unbound)   | git view, agent grid                              |
| `e`     | (unbound)   | built-in Neovim                                   |
| `[`     | copy mode   | opens the scrollback in `$EDITOR` inside the pane |

Rebind any of them under `[keys]` in `config.toml`.

## Process and port viewer

Open the viewer with `<prefix> + t`. Its keys work without the prefix:

| Key | Action |
| --- | --- |
| `p` | Switch between processes and ports |
| `j` / `k`, arrows | Move between rows |
| `g` / `G` | Move to the first / last row |
| `h` / `l`, left / right | Collapse / expand a process tree or port's socket details |
| `Tab`, `Enter`, `Space` | Toggle expansion |
| `/` | Filter by socket fields or process details; `Enter` / `Esc` clears the filter |
| `s` | Cycle sort modes; column headers select a sort directly |
| `F` | Follow the selected process or port group as rows reorder |
| `V` | Switch between flat and tree process views |
| `x` / `X` | Request termination / force kill, then confirm with `y` or cancel with `n` / `Esc` |
| `q` / `Esc` | Close the viewer (`Esc` first clears a filter or cancels confirmation) |

Ports initially sort with TCP listeners first, then by ascending port within
each category. All connections and UDP sockets remain visible. Choose the PORT
header for numeric sorting, or **Listeners first** to restore the initial order.
UDP `BOUND` means a socket has a local port; it does not identify a listening
service. While filtering, `p` is filter text rather than a mode switch.

Known owners group by local port and PID, with individual sockets and remote
endpoints available on expansion. Unknown owners group by protocol and local
and remote endpoints; matching endpoints do not establish a shared process
owner. Rows without process information cannot be signaled.

The viewer samples once per second. Port enumeration runs independently for
each viewer only while its ports view is open. Permissions can limit visibility:
on macOS, sockets belonging to inaccessible processes may be omitted entirely.

## Behaviors that differ

- **Window order.** Windows are numbered by display order, which defaults to
  alphabetical (`window-sort`). `n`, `p` and `0`-`9` follow that order, not
  creation order. Set `window-sort = "created"` for tmux numbering.
- **Kill confirmation.** `x` and `&` ask first, as in tmux. Killing the last
  pane closes its window; killing the last window kills the session. The last
  session cannot be killed. REST and MCP still refuse to remove the last pane or
  window.
- **send-prefix.** `<prefix> <prefix>` sends the prefix key to the pane, so
  `C-b C-b` reaches nested tmux or readline.
- **Resize.** `<prefix> C-Arrow` resizes by 1 cell and `<prefix> M-Arrow` by 5;
  the pane's edge in that direction moves. macOS reserves Ctrl+Arrow for Spaces,
  so rebind (for example `resize-pane-left = "M-ArrowLeft"`). Any
  `resize-pane-<direction>-<cells>` name works as an action.
- **Repeat.** Navigation and resize keys repeat for `repeat-time` ms (default
  `0`, which disables; try `500`) without the prefix. Any other key ends the window and goes
  to the terminal.
- **Scrolling and search.** `<prefix> PageUp` and `PageDown` scroll the active
  pane by a page and repeat like the arrow keys. `<prefix> /` opens a search bar
  over the pane's scrollback: Enter jumps to the next older match, Shift+Enter
  to a newer one, Esc closes it. It is a plain substring search, case-insensitive
  unless the query has an uppercase letter, and it searches a snapshot taken
  when the bar opens.
- **Paste.** `<prefix> ]` pastes the system clipboard, not a tmux buffer. The
  browser may ask for clipboard permission.
- **Prefix timeout.** The prefix expires after 2 seconds; tmux waits
  indefinitely.
- **Sessions are per tab.** The session you see comes from the URL, so two
  browser tabs can show different sessions. Window and pane selection is shared
  by all tabs. `L` toggles back to the tab's previous session.
- **No attach or detach.** Closing the tab is the detach; the server keeps the
  shells running. After a btmux restart the layout returns but processes and
  scrollback do not.
- **Size owner.** The first interactive viewer sets a pane's size until it
  leaves or another viewer types, pastes or clicks in it; tmux sizes to the
  smallest client by default.
- **Shell exit.** Exiting the last shell of the last session starts a fresh
  session "0" instead of ending the server.
- **Browser keys.** Cmd/Meta combinations and function keys are not forwarded to
  the terminal.
- **`vi-mode`.** It adds `h` `j` `k` `l` for pane navigation after the prefix
  and drops the `l` last-window binding. It is unrelated to tmux's `mode-keys`.
- **`[keys]`.** Each action has one key. Overriding it moves the action off its
  default key rather than adding a second one.

## Not available

- Copy mode and paste buffers (`=`, `#`). Select with the mouse; btmux has no
  buffer stack.
- tmux commands in `:`. The prompt is a palette of btmux commands, such as
  `select-layout-*`, not `split-window -h` or `resize-pane -R 5`.
- `d` detach, `!` break-pane, `.` move-window, `'` select window by prompt,
  `i` display message, `r` refresh, `C-o` rotate, `M-1`..`M-5` layouts.
- `bind-key`, `set-option` and a `.tmux.conf`; configuration is `config.toml`.
