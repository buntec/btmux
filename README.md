# btmux

A terminal emulator and tmux-style session manager. Runs as a stand-alone app and in the browser (including on mobile).
For macOS, Linux and Windows. Powered by [wterm](https://github.com/vercel-labs/wterm), [libghostty](https://github.com/ghostty-org/ghostty) and [Tauri](https://github.com/tauri-apps/tauri).

## Highlights

- Familiar tmux concepts and key bindings: sessions, windows, splits, zoom, etc.
- Server-side sessions: connect from any number of clients
- Tailscale integration: serve over HTTPS on your tailnet; log in from a phone/tablet by scanning a QR code
- Batteries included: file browser, Git GUI, process viewer, browser, Neovim GUI, VS Code integration
- Coding agent state tracking and notifications
- LaTeX rendering overlay
- Single self-contained binary (~20 MB)
- Interactive, composable shader wallpapers
- Support for base16/base24 color schemes, dark/light mode
- Highly configurable
- tmux-style CLI, REST API, MCP server and agent skill
- Nix Home-Manager module

## Demos

### Sessions, windows, and panes

https://github.com/user-attachments/assets/97306cfd-8c85-4134-911e-faada4723815

### File browser, Git mode, and process viewer

https://github.com/user-attachments/assets/5e3c9a36-0783-45ea-886d-db83b4969694

### Neovim GUI

https://github.com/user-attachments/assets/03185362-9673-48bc-97d8-c4695535c16f

### Coding agents

https://github.com/user-attachments/assets/1c1886e8-2c41-412d-8448-a128df24cadf

### LaTeX overlay

https://github.com/user-attachments/assets/716d0792-8989-43f7-887d-76d25f368321

### Shader wallpapers

https://github.com/user-attachments/assets/4417fcdf-7d8f-4a2f-92ba-3144927a4ff2

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

**Desktop app**: open btmux. With no server running, it starts its own and
connects, with no sign-in. If it finds other btmux servers, it
[offers to connect to one](desktop/README.md) instead.

**Browser / CLI**: run `btmux`. It opens `http://127.0.0.1:8004` and prints the
path of its access token file. Sign in with username `btmux` and the file's
contents as the password (see [Access tokens](docs/installation.md#access-tokens-and-reverse-proxies)).

Key bindings start with a prefix, as in tmux, by default `C-a` (Ctrl+A). Press
`<prefix> + ?` to see them all, or `<prefix> + :` to open the command palette.

## Learn more

- [Installation](docs/installation.md): Windows, services, tokens, remote access, and shell completions
- [Phones, tablets, and Tailscale](docs/phones-and-tailscale.md): serving over HTTPS on your tailnet, QR sign-in, and touch screens
- [In-place upgrades](docs/upgrade.md): how `btmux upgrade` keeps shells running across a new binary
- [Configuration](docs/configuration.md): `~/.config/btmux/config.toml` (`%APPDATA%\btmux\config.toml` on Windows), themes, and profiles
- [Shader wallpapers](docs/shaders.md): WebGPU generators, parameters, and randomization
- [btmux for tmux users](docs/tmux.md): where keys and behavior differ from tmux
- [Comparison](docs/competitors.md): feature matrix of btmux versus similar projects
- [Editors](docs/editors.md): choosing what `<prefix> + e` and the file browser open
- [Neovim GUI](docs/neovim.md): the Neovim GUI, its plugin, and config tips
- [VS Code](docs/vscode.md): VS Code over a pane, its server, and sharing desktop settings and extensions
- [Browser](docs/browser.md): a server-side Chrome or Chromium over a pane
- [Automation and AI agents](docs/automation.md): tmux-style commands, agent skill, REST API, MCP, and agent notifications
- [Development](docs/development.md): building and running btmux from a checkout

## License

[MIT](LICENSE)
