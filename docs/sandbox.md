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
on a local one. A pane `cd`'d outside the mount shows as remote. If the mount
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

## What the sandbox doesn't cover

- The mount is read-write. A linked Git worktree also gets its repository's
  `.git` directory mounted, which Git needs there; a hook written in it runs
  the next time you use Git on the host.
- The process viewer doesn't count programs in the instance.
- Shells run over Multipass's SSH connection: if the host sleeps or Multipass
  restarts, sandboxed panes close.
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
cloud-init = "~/btmux-cloud-init.yaml"   # instead of btmux's
```

All but `shell` apply when btmux creates the instance. To change them later,
run `multipass delete --purge btmux-sandbox`; the next sandboxed pane creates
it again.

REST (`POST /api/sessions` with `"runtime": {"type": "multipass", "mounts":
["/path"], "shell": "bash"}`) and MCP (`create_session` with `sandbox_mounts`)
create sandboxed sessions too.
