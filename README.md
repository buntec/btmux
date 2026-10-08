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
- Base16/24 themes and WebGPU shader wallpapers, all hot-reloaded
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
- [btmux for tmux users](docs/tmux.md): where keys and behavior differ from tmux
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

### Shader wallpapers

Shader wallpapers use the MIT-licensed [Shaders](https://shaders.com/docs/guide)
components, bundled locally with btmux. Choose a generator in Settings → Wallpaper,
edit its native parameters, and copy the generated TOML to persist the settings.
Parameter changes preview immediately; Apply changes only the running server.

```toml
wallpaper-shader = "aurora"
wallpaper-opacity = 0.25
wallpaper-speed = 0.2
wallpaper-fps = 30
wallpaper-resolution = 0.4

[wallpaper-shader-params.aurora]
color-a = "#a533f8"
color-b = "#22ee88"
curtain-count = 3
speed = 2.0
center = { x = 0.5, y = 0.0 }
```

Each generator has its own parameter table. Names use kebab-case, matching the
Settings TOML export; colors, numbers, booleans, positions, and gradient stop arrays
are supported. The global wallpaper speed multiplies native speed parameters,
or scales simulation time for interactive effects.
The wallpaper seed supplies a numeric seed only when a generator's own `seed`
parameter is unset. Cursor-following moves `center` or `position` on generators
that expose those parameters and supplies input to interactive effects.

Randomize parameters, below the selected shader's controls, generates a complete
parameter set including native seeds. Colors share a coordinated palette, gradient
stops stay ordered, and numeric values stay within sensible native ranges. It
previews immediately and changes only the selected shader's parameters; Apply and
the TOML export work as with manual edits.

Interactive wallpapers include `chroma-flow`, `cursor-trail`, `ink-flow`, and
`boids`, with their native parameters available in Settings. The flow and trail
effects respond to mouse or terminal-cursor movement; Boids animates an autonomous
flock that can attract or repel the cursor. The cursor-following switches control
which input sources reach them, and disabling animations freezes simulations.

WebGPU is required; unsupported browsers and GPU failures leave the theme
background visible. Frame rates are capped to 10–60 FPS, and background tabs,
modal transitions, and disabled animations pause continuous rendering. Wallpaper
changes preserve terminal instances and pane sockets. No hosted presets or
runtime shader downloads are used, and shader telemetry is disabled by using the
core renderer without a telemetry collector.

The old Radiant and custom wallpaper IDs are retired; select one of the new
generators instead. Terminal post-processing is also retired: old `shader = ...`
config entries are accepted and ignored.

After updating the pinned `shaders` dependency, run `just sync-shaders` to refresh
its parameter metadata and lazy loaders.
