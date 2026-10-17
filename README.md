# btmux

A tmux-style terminal manager for the browser and desktop, powered by [ghostty-web](https://github.com/rcarmo/ghostty-web).

https://github.com/user-attachments/assets/93f11edd-8dbe-4faa-a96c-5f0265c4906a

## Highlights

- Familiar tmux concepts and key bindings: sessions, windows, splits, zoom, and preset layouts
- Server-side sessions: (re)connect from any number of frontends
- Batteries included: file browser, Git mode, process viewer, Neovim GUI
- Coding agent state tracking and notifications
- Single self-contained binary
- Interactive shader wallpapers
- Support for base16/base24 color schemes
- Highly configurable
- REST API and MCP server

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

## Neovim GUI

`<prefix> + e` opens a Neovim GUI drawn by btmux, with its command line,
completion menu, messages, LSP signature help, and floating windows rendered as native UI. The file
browser and Git mode open files there by default. It needs Neovim 0.12 or newer
(without it, files open in the pane);
see [Neovim GUI](docs/neovim.md) for config tips and the bundled plugin.

## Learn more

- [Installation](docs/installation.md): services, tokens, remote access, and shell completions
- [In-place upgrades](docs/upgrade.md): how `btmux upgrade` keeps shells running across a new binary
- [Configuration](docs/configuration.md): `~/.config/btmux/config.toml`, themes, and profiles
- [Shader wallpapers](docs/shaders.md): WebGPU generators, parameters, and randomization
- [btmux for tmux users](docs/tmux.md): where keys and behavior differ from tmux
- [Neovim GUI](docs/neovim.md): the Neovim GUI, its plugin, and config tips
- [Automation and AI agents](docs/automation.md): REST API, MCP, and agent notifications

## Development

Requires [Rust](https://rustup.rs), [Bun](https://bun.sh), and [`just`](https://github.com/casey/just).
On macOS, install Xcode Command Line Tools (`xcode-select --install`): socket
enumeration builds generate bindings using the macOS SDK and libclang. If
libclang is installed separately, set `LIBCLANG_PATH` to its library directory.
The pinned socket enumeration dependency does not require libclang on Linux.

```sh
just setup  # install dependencies
just dev    # backend on :8044, frontend on http://localhost:5173
just check  # type-check Rust and TypeScript
```

Run `just` to list all recipes. The dev server uses the `dev` profile, so its
token is in `~/.local/state/btmux/dev/state.token`.

## License

[MIT](LICENSE)
