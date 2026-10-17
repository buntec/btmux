# How in-place upgrades work

`btmux upgrade` swaps in a new btmux binary without killing your shells. The
server process turns itself into the new program but keeps the same process ID,
and passes everything still running over to it.

## The key trick: `execve`

On Unix, `execve` replaces the program running inside a process without
creating a new process. The process ID stays the same, and so do any open file
descriptors that aren't marked close-on-exec. So if btmux execs its own new
binary:

- **Your shells stay alive.** They're child processes of btmux, and since the
  process ID doesn't change, they're still its children afterwards.
- **The PTY connections stay open.** Each pane talks to its shell through a PTY
  master file descriptor. btmux clears the close-on-exec flag on these, so the
  new program inherits them.
- **The listening socket stays open.** Browsers can reconnect to the same port
  right away. No other process can grab the port in between.
- **The profile lock stays held,** so no other btmux instance can take the
  profile in the meantime.

Open descriptors aren't enough on their own, though. The new program also needs
the server's in-memory state, which is what the handoff file is for.

## Step by step

1. **You run `btmux upgrade`** with the new binary. The CLI finds the running
   server through its `state.server` record and sends
   `POST /api/server/upgrade` with its own executable path.

2. **The server checks whether the upgrade is safe:**
   - It runs `<new binary> <server arguments> handoff-version` and compares
     the handoff format number. If the formats differ, or the new binary
     rejects the arguments the server was started with (which the exec passes
     on), it refuses, and you need a normal restart.
   - It refuses to upgrade while the built-in Neovim has unsaved changes.

3. **It tells the browsers.** Each tab gets a toast: "Upgrading btmux to X…"

4. **It freezes everything:**
   - It takes the session-manager write lock and holds it until the exec, so
     nothing can change in the meantime.
   - It quits Neovim with `:qall` and stops VS Code. Those don't survive the
     upgrade; your files are already saved.
   - It stops every PTY reader and writer. Output the shell produces from now
     on just waits in the kernel's PTY buffer until the new server reads it.
   - It saves `state.json` as usual, as a fallback.

5. **It writes the handoff file.** The file is created and then immediately
   deleted, so only the open file descriptor keeps it alive, and nothing is left
   on disk. It contains:
   - A JSON header: the session/window/pane tree, plus for each pane its PTY
     descriptor number, shell process ID, size, title, cwd, and colors the
     program set.
   - The raw bytes after the header: each pane's replay journal (so browsers
     can redraw scrollback), any escape sequence that was half-read when the
     reader stopped, and keyboard input that was accepted but not yet written to
     the shell.

6. **It execs.** The handoff file's descriptor number goes into the
   `BTMUX_HANDOFF` environment variable, and the process runs the new binary
   with the same arguments.

7. **The new binary takes over.** Early in startup it sees `BTMUX_HANDOFF`,
   removes it from the environment so shells don't inherit it, and reads the
   file. It then rebuilds sessions and panes and attaches each pane to its
   existing PTY and shell. It never spawns new shells.

8. **Browsers reconnect.** Their WebSockets dropped during the exec, so they
   reconnect as usual, get the replayed journal, and see their terminals
   exactly as before. After reconnecting, the frontend notices the server
   version changed and shows a toast.

9. **The CLI confirms the result.** It polls `/api/info` until the server
   instance ID changes, then checks that the process ID did _not_ change. A
   changed instance with the same PID means a real in-place upgrade. A
   different PID means something like launchd/systemd restarted the server
   instead, and the shells were lost, so the CLI reports an error.

## If something goes wrong

- **Refused before anything stopped** (incompatible binary, unsaved Neovim
  buffers): the server keeps running unchanged, and `btmux upgrade` exits with
  status 3. The Home Manager module uses that code to tell this case apart from
  a real failure.
- **A pane doesn't stop within 2 seconds:** the upgrade fails before the exec,
  and every pane restarts. A pane that stops within 5 more seconds keeps its
  state; after that it restarts anyway, losing the colors the program set
  and any partly read escape sequence.
- **`execve` itself fails:** the server marks the descriptors close-on-exec
  again, restarts the PTY readers and writers it stopped, toasts an error, and
  records it as `upgrade_error` in `/api/info` so the CLI can report it. Your
  shells never noticed anything.

## Keeping the two versions compatible

The old binary writes the handoff file and the new binary reads it, so both
must agree on its format. `handoff::VERSION` is that agreement. A test records
the file's exact shape in `src/handoff.schema` and fails if the shape changes
without a version bump. That stops a new binary from misreading an old server's
handoff.

The implementation lives in [`src/handoff.rs`](../src/handoff.rs).
