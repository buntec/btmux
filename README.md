# btmux

A browser-based terminal manager with a tmux-inspired interface, powered by a
[ghostty-web fork](https://github.com/rcarmo/ghostty-web).

Run real shells in your browser, organize them into sessions, windows, and
panes, and reconnect without losing the current terminal view.

## Highlights

- Sessions, windows, splits, pane zoom, pane swapping, and preset layouts
- Searchable session tree, live window thumbnails, and a keyboard-driven file browser
- Configurable tmux-style keybindings with optional vi-style navigation
- Hot-reloaded themes, terminal options, bundled fonts, wallpapers, and WebGL effects
- Host statistics and pane notifications for coding agents
- REST API and MCP server for automation

## Demo

https://github.com/user-attachments/assets/5fade3d9-9ee1-49ae-9460-16a15a0ec49a

## Get started

### Install and launch

On Apple Silicon macOS or x86-64/ARM64 Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

This installs the latest release to `~/.local/bin` by default. Then start btmux:

```sh
btmux
```

It opens the UI at `http://localhost:8004`.

For background service setup, building from source, Home Manager, and supported
platforms, see [Installation](docs/installation.md).

### Sign in

btmux requires an access token, including on localhost. On first launch it
creates `~/.local/state/btmux/state.token` and prints the file's path. In another
terminal, read the token with:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token"
```

Enter **`btmux` as the browser username** and **the token as the password**.
Once signed in, press `<prefix> + ?` to see the keybindings.

If you use `--profile NAME`, the token is in
`~/.local/state/btmux/NAME/state.token`. Setting `XDG_STATE_HOME` replaces
`~/.local/state` in these paths. If you start the server with `BTMUX_AUTH_TOKEN`
set, use that value instead of a token file.

See [Access tokens and reverse proxies](docs/installation.md#access-tokens-and-reverse-proxies)
for token management and HTTPS setup for remote access.

## Configuration

On first launch, btmux creates a configuration file at
`~/.config/btmux/config.toml` (or `$XDG_CONFIG_HOME/btmux/config.toml`). Changes
are picked up live.

```sh
btmux generate-config   # print every option with documentation
```

See [Configuration](docs/configuration.md) for appearance settings, themes,
profiles, and state persistence.

## Automation

btmux exposes a REST API and an MCP server on the same address as the web UI.
It also supports pane notifications from Claude Code, Codex, and Gemini CLI.

API and MCP clients authenticate with the same access token. See
[Automation and AI agents](docs/automation.md#authentication) for authentication,
endpoints, and setup.

## Command line

```sh
btmux                   # start the server and open the browser
btmux --no-browser      # start without opening a browser tab
btmux --help            # show all flags and subcommands
btmux version           # print the installed version
btmux generate-config   # print a documented default config
```

## Development

Requires [Rust](https://rustup.rs), [Bun](https://bun.sh), and
[`just`](https://github.com/casey/just).

```sh
just setup  # install dependencies
just dev    # backend on :8044, frontend on :5173
just check  # check Rust and TypeScript
just build  # build the frontend and release binary
just run    # serve the production build on :8004
```

Develop against `http://localhost:5173`; Vite proxies API and WebSocket traffic
to the development backend. `just dev` uses the separate `dev` profile. Read its
token and paste it into the development UI's access-token form:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/dev/state.token"
```

## License

[MIT](LICENSE)
