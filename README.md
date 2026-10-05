# btmux

A tmux-style terminal manager for the browser and desktop, powered by
[ghostty-web](https://github.com/rcarmo/ghostty-web). Sessions live on the
server, so you can close a tab and reconnect from any browser without losing
anything. Key bindings follow tmux defaults (`<prefix> + %`, `<prefix> + "`, …).

https://github.com/user-attachments/assets/9180b2ed-43cb-4dbb-bccd-ac5f0cfc4944

## Highlights

- Single static binary that bundles all assets
- Sessions, windows, splits, zoom, and preset layouts
- Live window thumbnails, file browser, and Git UI
- Base16/24 themes, wallpapers, and WebGL effects, all hot-reloaded
- Notifications for coding agents, plus a REST API and MCP server

## Install

**Desktop app** (macOS Apple Silicon):

```sh
brew install --cask buntec/btmux/btmux
```

Linux `.deb` packages are on the [Releases](https://github.com/buntec/btmux/releases/latest) page.
The macOS app is unsigned; if macOS blocks it, go to **System Settings → Privacy & Security → Open Anyway**.
See [desktop details](desktop/README.md).

**Browser / CLI** (macOS or Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
# or: brew install buntec/btmux/btmux
```

Homebrew, background services, and Home Manager are covered in [Installation](docs/installation.md).

## Quick start

```sh
btmux
```

This opens `http://127.0.0.1:8004`. Sign in with username `btmux` and the
access token printed on first launch:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token"
```

Press `<prefix> + ?` to see all key bindings, or `<prefix> + :` to open the command palette.

## Learn more

- [Installation](docs/installation.md): services, tokens, remote access, and shell completions
- [Configuration](docs/configuration.md): `~/.config/btmux/config.toml`, themes, and profiles
- [Automation and AI agents](docs/automation.md): REST API, MCP, and agent notifications

## Development

Requires [Rust](https://rustup.rs), [Bun](https://bun.sh), and [`just`](https://github.com/casey/just).

```sh
just setup  # install dependencies
just dev    # backend on :8044, frontend on http://localhost:5173
just check  # type-check Rust and TypeScript
```

Run `just` to list all recipes. The dev server uses the `dev` profile, so its
token is in `~/.local/state/btmux/dev/state.token`.

## License

[MIT](LICENSE)
