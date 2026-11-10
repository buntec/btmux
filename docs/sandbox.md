# Sandboxed sessions

A session can run its shells in a [Multipass](https://multipass.run) Ubuntu VM
instead of on the server, so coding agents in it see only the directory you
give them. In the new-session dialog (`<prefix> + C`), choose **Runs on:
Multipass sandbox**, then a directory to mount (the active pane's worktree by
default) and a shell (bash, zsh, or fish).

Requires macOS or Linux, and Multipass installed on the server.

## How it works

All sandboxed sessions share one instance, `btmux-sandbox` (other profiles add
`-<profile>`). The first sandboxed pane creates it, which downloads an Ubuntu
image and installs build tools, the three shells, Claude Code, and Codex; this
takes a few minutes and shows its progress in the pane. Later panes start in
a second or two, and a stopped instance is started again.

The mounted directory appears at the **same path** in the instance, so the
file browser, Git mode, and the editors work on a sandboxed pane's directory as
on a local one. A pane `cd`'d outside the mount shows as remote. A worktree
made from a sandboxed session (`<prefix> + W`) is mounted too. If the mount
says "Permission denied" in the instance, Multipass can't read the directory:
on macOS, give `multipassd` Full Disk Access for folders like `~/Documents`, and
avoid directories inside ones only you can open, such as a per-user temp dir.

btmux puts its own binary in the instance and installs its agent hooks there,
so agent status, notifications, usage, and `btmux pick` work. The instance
reaches the server on the Multipass network with a token that can only report
for sandboxed panes: it can't type into panes, read their output, or create
sessions.

Log in to Claude Code or Codex once in a sandboxed pane. The login stays in
the instance, so every sandboxed session uses it.

The status bar's box button shows the instance's state, CPUs, memory, and
disk, and starts, stops, restarts, or deletes it (`multipass delete --purge`),
which you'd do to start over or apply new `[multipass]` settings. When the
instance stops or is deleted, sandboxed panes stay open and offer to start or
create it again: press Enter. Sessions and their layouts are kept.

## Your shell config

The instance has its own home directory. To bring your prompt, aliases, and
other dotfiles, list them in `copy`; each pane start copies them to the same
place in the instance's home when they've changed:

```toml
[multipass]
copy = ["~/.config/fish", "~/.config/starship.toml", "~/.gitconfig"]
```

Entries must be in your home directory. Symlinks are followed, so dotfile
managers that link into a store (Home Manager, GNU Stow) work. It's a one-way
copy: changes in the instance don't come back, and files you remove aren't
removed there.

Copy only what the sandbox may see: agents in it can read everything copied,
so leave out config that holds credentials (API keys exported in a shell
config, fish's `fish_variables`, `~/.ssh`). Config that calls tools the
instance lacks (like `starship init`) fails there; install them with your own
`cloud-init`, or guard that part with `if test "$BTMUX_BIN" = /usr/local/bin/btmux`.

## What the sandbox doesn't cover

- The mount is read-write, and what the instance writes there runs on the
  host when you use it: build scripts, `.envrc`, editor settings, and Git's
  hooks and config (`core.fsmonitor`, `core.hooksPath`, filters) in the
  repository's `.git`, which a mounted repository includes and a linked
  worktree gets mounted too, since Git needs it there. Review changes before
  building them or running Git on the host, or run Git in a sandboxed pane.
  The status and diffs btmux shows run none of them; Git mode's actions,
  like pull and push, run `git`.
- The process viewer doesn't count programs in the instance.
- Shells run over Multipass's SSH connection: if the host sleeps or Multipass
  restarts while the instance keeps running, a pane whose shell was cut off
  closes.
- The browser surface's `localhost` is the server, not the instance.

## Configuration

```toml
[multipass]
instance = "btmux-sandbox"   # default; other profiles append "-<profile>"
image = "26.04"
cpus = 4
memory = "8G"
disk = "40G"
shell = "fish"     # the shell new sandboxed sessions offer first (default: yours)
cloud-init = "~/btmux-cloud-init.yaml"   # instead of btmux's; a file or URL
copy = ["~/.config/fish"]   # into the instance's home when a pane starts
```

All but `shell` and `copy` apply when btmux creates the instance. To change
them later, delete it from the status bar (or run `multipass delete --purge
btmux-sandbox`); the next sandboxed pane creates it again.

REST (`POST /api/sessions` with `"runtime": {"type": "multipass", "mounts":
["/path"], "shell": "bash"}`) and MCP (`create_session` with `sandbox_mounts`)
create sandboxed sessions too.
