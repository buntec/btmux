# btmux

A terminal emulator and tmux-style session manager for the browser and desktop, powered by [wterm](https://github.com/vercel-labs/wterm) and [libghostty](https://github.com/ghostty-org/ghostty).

## Highlights

- Familiar tmux concepts and key bindings: sessions, windows, splits, zoom, and preset layouts
- Server-side sessions: (re)connect from any number of frontends
- Batteries included: file browser, Git mode, process viewer, Neovim GUI, VS Code integration
- Coding agent state tracking and notifications
- LaTeX rendering overlay
- Single self-contained binary
- Interactive, composable shader wallpapers
- Support for base16/base24 color schemes, dark/light mode
- Highly configurable
- REST API and MCP server

## Demos

### Sessions, windows, and panes

https://github.com/user-attachments/assets/0e0ca159-226e-4762-b6a7-8ae255dde4f6

### File browser, Git mode, and process viewer

https://github.com/user-attachments/assets/ac8185dd-c36f-41df-8dff-66529d03d6bb

### Neovim GUI

https://github.com/user-attachments/assets/a9233ccb-ca09-4ff2-86a3-2383058d509f

### Coding agents

https://github.com/user-attachments/assets/7d5310c6-c136-4ea3-add2-e60bbecdfcd5

### LaTeX overlay

https://github.com/user-attachments/assets/64030ce9-b851-468b-90cf-433f481845c3

### Shader wallpapers

https://github.com/user-attachments/assets/b297b31c-2744-4e90-91a5-f917f5736bf5

## Install

Release builds cover Apple Silicon macOS, x86-64/ARM64 Linux, and x64/ARM64
Windows. Windows support is experimental.

**Desktop app**:

- macOS: `brew install --cask buntec/btmux/btmux`
- Linux: install `btmux-desktop-<arch>-unknown-linux-gnu.deb` from [Releases](https://github.com/buntec/btmux/releases/latest).
- Windows: run `btmux-desktop-<arch>-pc-windows-msvc-setup.exe` from [Releases](https://github.com/buntec/btmux/releases/latest). It installs for the current user, without admin rights.

The macOS app and Windows installers are unsigned. If macOS blocks the app, go
to **System Settings → Privacy & Security → Open Anyway**; if SmartScreen blocks
the installer, choose **More info → Run anyway**. See [desktop details](desktop/README.md).

**Browser / CLI** on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
# or: brew install buntec/btmux/btmux
```

**Browser / CLI** on Windows: download `btmux-x86_64-pc-windows-msvc.exe` or
`btmux-aarch64-pc-windows-msvc.exe` from
[Releases](https://github.com/buntec/btmux/releases/latest), rename it to
`btmux.exe`, and put it in a directory on your `PATH`. For example, in PowerShell:

```powershell
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
$dir = "$env:LOCALAPPDATA\Programs\btmux"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "https://github.com/buntec/btmux/releases/latest/download/btmux-$arch-pc-windows-msvc.exe" -OutFile "$dir\btmux.exe"
[Environment]::SetEnvironmentVariable('Path', "$([Environment]::GetEnvironmentVariable('Path', 'User'));$dir", 'User')
```

On Windows:

- Panes run `powershell.exe` by default. Set `shell` in `config.toml` to use
  `pwsh`, `cmd.exe`, Git Bash, or a WSL distribution (`wsl.exe -d Ubuntu`).
- The config file is `%APPDATA%\btmux\config.toml`, and the access token is in
  `%LOCALAPPDATA%\btmux\state.token` (`Get-Content "$env:LOCALAPPDATA\btmux\state.token"`).
- `btmux install` (background service) and `btmux upgrade` (in-place upgrade)
  aren't supported. To update, quit btmux, replace `btmux.exe`, and start it again.

Homebrew, Windows, background services, and Home Manager are covered in [Installation](docs/installation.md).

## Quick start

```sh
btmux
```

This opens `http://127.0.0.1:8004`. Sign in with username `btmux` and the
access token from the file whose path btmux prints at startup:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token"
```

On Windows, in PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\btmux\state.token"
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

- [Installation](docs/installation.md): Windows, services, tokens, remote access, and shell completions
- [In-place upgrades](docs/upgrade.md): how `btmux upgrade` keeps shells running across a new binary
- [Configuration](docs/configuration.md): `~/.config/btmux/config.toml` (`%APPDATA%\btmux\config.toml` on Windows), themes, editors, and profiles
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
On Windows, install the MSVC build tools Rust needs. `just setup` and the
desktop recipes run in PowerShell; the others need `sh`, so run them from Git
Bash or put `C:\Program Files\Git\bin` on `PATH`.

```sh
just setup  # install dependencies
just dev    # backend on :8044, frontend on http://localhost:5173
just check  # type-check Rust and TypeScript
```

Run `just` to list all recipes. The dev server uses the `dev` profile and the
fixed access token `1234`.

## License

[MIT](LICENSE)
