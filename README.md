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
