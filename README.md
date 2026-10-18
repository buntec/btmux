# btmux

A tmux-style terminal manager for the browser and desktop, powered by [wterm](https://github.com/vercel-labs/wterm) and [libghostty](https://github.com/ghostty-org/ghostty).

## Highlights

- Familiar tmux concepts and key bindings: sessions, windows, splits, zoom, and preset layouts
- Server-side sessions: (re)connect from any number of frontends
- Batteries included: file browser, Git mode, process viewer, Neovim GUI, VS Code integration
- Coding agent state tracking and notifications
- Single self-contained binary
- Interactive shader wallpapers
- Support for base16/base24 color schemes
- Highly configurable
- REST API and MCP server

## Demos

### Sessions, windows, and panes

https://github.com/user-attachments/assets/f120a4d9-7736-4415-9677-b3a33695be70

### File browser, Git mode, and process viewer

https://github.com/user-attachments/assets/ac87f6ac-3484-4f20-973f-73ef6d1d6b6f

### Neovim GUI

https://github.com/user-attachments/assets/eb5a2e6f-e1fa-4693-aedc-826e3cc078ab

### Coding agents

https://github.com/user-attachments/assets/c7ed8b36-b9b2-4a5c-8f92-3fa410e52e65

### LaTeX overlay

https://github.com/user-attachments/assets/a5eb0d69-40dc-4394-b75b-3b435f5c2ab5

### Shader wallpapers

https://github.com/user-attachments/assets/45419669-7e95-4e4b-9eb4-74b6746887f4

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

## Editor

`<prefix> + e` opens the configured `editor` over the active pane, and the file
browser and Git mode open files there:

- `"neovim"`: a Neovim GUI drawn by btmux, with its command line, completion
  menu, messages, LSP signature help, and floating windows rendered as native
  UI. The default when Neovim 0.12 or newer is on `PATH`; see
  [Neovim GUI](docs/neovim.md).
- `"vscode"`: VS Code in the browser, using btmux's color scheme and font.
- `"pane"`: `$EDITOR` run in the pane's shell. The default without Neovim 0.12.

See [Editor](docs/configuration.md#editor) for details.

## Learn more

- [Installation](docs/installation.md): services, tokens, remote access, and shell completions
- [In-place upgrades](docs/upgrade.md): how `btmux upgrade` keeps shells running across a new binary
- [Configuration](docs/configuration.md): `~/.config/btmux/config.toml`, themes, editors, and profiles
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

Run `just` to list all recipes. The dev server uses the `dev` profile and the
fixed access token `1234`.

## License

[MIT](LICENSE)
