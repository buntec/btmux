# Installation

## Release installer

The installer supports Apple Silicon macOS and x86-64/ARM64 Linux. Intel macOS
is not currently supported.

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

It downloads the latest release binary to `~/.local/bin`. Set
`BTMUX_INSTALL_DIR` to choose another location.

## Windows

Windows support (x64 and ARM64) is experimental. Download the release binary
and put it on your `PATH`, for example in PowerShell:

```powershell
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
$dir = "$env:LOCALAPPDATA\Programs\btmux"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "https://github.com/buntec/btmux/releases/latest/download/btmux-$arch-pc-windows-msvc.exe" -OutFile "$dir\btmux.exe"
[Environment]::SetEnvironmentVariable('Path', "$([Environment]::GetEnvironmentVariable('Path', 'User'));$dir", 'User')
```

Open a new terminal so it picks up the `PATH` change. The desktop app's
installer, `btmux-desktop-<arch>-pc-windows-msvc-setup.exe`, is on the
[Releases](https://github.com/buntec/btmux/releases/latest) page; both are
unsigned, so SmartScreen may ask you to choose **More info → Run anyway**.

Panes run `powershell.exe` by default. Set `shell` in
`%APPDATA%\btmux\config.toml` to another command line: `pwsh`, `cmd.exe`,
`'C:\Program Files\Git\bin\bash.exe'` (Git Bash), or `wsl.exe -d Ubuntu`.
Under bash, btmux tracks the pane's directory with `PROMPT_COMMAND` and `PS0`;
if your bashrc replaces them, emit OSC 7 and OSC 133 A/C marks yourself.

There is no background service or in-place upgrade on Windows. To update, quit
btmux (and the desktop app), replace `btmux.exe` or run the new desktop
installer, and start it again. Running shells end, but the saved sessions,
windows, and pane directories are restored.

## Homebrew

The [buntec/homebrew-btmux](https://github.com/buntec/homebrew-btmux) tap has a
formula for the server/CLI (Apple Silicon macOS, x86-64/ARM64 Linux) and a cask
for the desktop app (Apple Silicon macOS):

```sh
brew install buntec/btmux/btmux          # server/CLI
brew install --cask buntec/btmux/btmux   # desktop app
```

The desktop app is not notarized; the cask clears its quarantine attribute so
macOS does not block it. Both are updated with each release.

To upgrade, update the tap first, then move the background service (see
`btmux install`) to the new binary:

```sh
brew update
brew upgrade buntec/btmux/btmux            # server/CLI
brew upgrade --cask buntec/btmux/btmux     # desktop app
btmux upgrade                              # keeps running pane processes
```

Skipping `brew update` can leave a stale tap that doesn't list the new release.
`btmux upgrade` re-executes the running server in place, keeping its shells and
scrollback; if it reports that the running server can't take over (it predates
the command, or the upgrade format changed), run `btmux restart` instead, which
ends running pane processes. It refuses while the built-in Neovim has unsaved
changes, and exits with status 3 when the server keeps running the old version.
[How in-place upgrades work](upgrade.md) explains the mechanism. Without either the service keeps the old version,
and the desktop app shows
a version-mismatch warning (**About btmux** lists both versions). A service
installed from Homebrew points at the version-independent
`<prefix>/opt/btmux/bin/btmux`, so it survives upgrades; if you installed it
with an older btmux, re-run `btmux install` once. Quit the desktop app before
upgrading the cask.

## Access tokens and reverse proxies

### First sign-in

Start `btmux`, then open `http://127.0.0.1:8004`. Access requires a token even
on localhost. Unless `BTMUX_AUTH_TOKEN` is set, btmux creates an owner-only
`state.token` beside the profile's `state.json` and prints its path on startup.

| Instance                        | Default token file                      |
| ------------------------------- | --------------------------------------- |
| `btmux`                         | `~/.local/state/btmux/state.token`      |
| `btmux --profile NAME`          | `~/.local/state/btmux/NAME/state.token` |
| `just dev` / `just dev-backend` | `~/.local/state/btmux/dev/state.token`  |

These paths apply on both macOS and Linux. On Windows, `%LOCALAPPDATA%`
replaces `~/.local/state` (`%LOCALAPPDATA%\btmux\state.token`). If
`XDG_STATE_HOME` is set, it replaces either. For the default instance, read the
token with:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token"
```

or, in PowerShell on Windows:

```powershell
Get-Content "$env:LOCALAPPDATA\btmux\state.token"
```

Enter `btmux` as the browser username and the file's contents as the password.
The development frontend at `http://localhost:5173` instead shows an access-token
form; paste the `dev` profile's token there. A background service uses the same
file locations, so you can retrieve its token without reading service logs.

### Token management

Tokens survive restarts. To rotate a generated token, stop the server, delete
its token file, and restart it to generate a new one. Alternatively, start the
server with `BTMUX_AUTH_TOKEN` set to at least 4 ASCII letters, digits, `-`, or
`_`; this overrides the token file.

The token grants access to the instance's shells, sessions, and files available
to the btmux user. Never put credentials in URLs. The browser session uses an
HttpOnly, SameSite=Strict cookie; HTTPS public URLs use Secure cookies.
See [Automation authentication](automation.md#authentication) for API, MCP,
and agent-hook clients.

Run concurrent instances with different `--profile` names. A file lock prevents
two instances from overwriting the same saved sessions. `just dev` and
`just dev-backend` use the `dev` profile automatically.

### Remote access

For a remote deployment, terminate HTTPS at a trusted reverse proxy and pass its
external origin explicitly, for example `--public-url https://terminal.example.com`.
Preserve the public Host header (or use the configured backend authority) and
forward WebSocket upgrades. Forwarded headers never implicitly grant trust.
Plain HTTP does not encrypt the access token or terminal traffic.

### Tailscale

To reach btmux from other devices on your
[tailnet](https://tailscale.com), including phones, start it with
`--tailscale`:

```sh
btmux --tailscale                        # https://<machine>.<tailnet>.ts.net:8004
btmux --tailscale install                # the same, as a background service
```

btmux runs `tailscale serve --bg --https=<port>`, which serves the machine's
tailnet name over HTTPS with a Tailscale certificate and proxies to btmux on
loopback, and prints the URL. btmux itself stays on `127.0.0.1`. It never
replaces another route on that port: if one exists, btmux serves locally and
reports it, so choose another `--port`. A route that already points at btmux is
used as is. Shutting down removes only a route btmux created (recorded in
`state.tailscale` beside the profile's state); an upgrade keeps it. If Tailscale
isn't running yet, btmux keeps serving locally and retries every 10 seconds.
The status bar's tailnet button shows the URL, with a copy button, or the
last error.

This needs the `tailscale` CLI (on macOS, the app's bundled CLI also works),
[MagicDNS](https://tailscale.com/kb/1081/magicdns), and
[HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled for
the tailnet. Sign in with the access token as above; browsers keep the login for
400 days. HTTPS matters even though the tailnet is encrypted: browsers allow
the clipboard, notifications, and WebGPU shader wallpapers only on secure
origins.

In the desktop app, a desktop server kept running after the app quits can
also be shared this way: check **Share it on my tailnet** before starting it.
It then keeps its port across starts, so its tailnet URL stays the same.

### Phones and tablets

On touch devices, a key bar above the status bar supplies the keys on-screen
keyboards lack: Esc, Tab, arrows, the prefix, and Ctrl and Alt, which apply to
the next key typed or tapped. It also opens the command palette, cycles panes,
and hides the keyboard. Swipes scroll full-screen programs such as `less` the
way a mouse wheel does. On narrow screens, a window with several panes shows
only the active one. Add btmux to the home screen to run it without browser
chrome; it needs HTTPS, so serve it with `--tailscale` or through a reverse proxy.

## Background service

btmux can install itself as a per-user service that starts at login and restarts
after a crash. It uses a launchd LaunchAgent on macOS and a systemd user unit on
Linux.

```sh
btmux install              # install and start on 127.0.0.1:8004
btmux --port 8004 install  # bake command-line options into the service
btmux install --print      # print the unit without installing it
btmux upgrade              # move the running server to this binary, keeping shells
btmux restart              # restart the installed service
btmux uninstall            # stop and remove the service
```

The `--host`, `--port`, `--profile`, `--shell`, `--public-url`, and `--tailscale` flags, along
with your shell's `PATH`, are captured when the service is installed. Re-run
`btmux install` after changing them.

Install the service from a stable binary path such as `~/.local/bin/btmux`.
Using a `target/` build artifact will break the service after `cargo clean` or a
rebuild that replaces the binary.

Windows has no service support yet: `btmux install` exits with an error. Run
`btmux` in a terminal instead, or use the desktop app.

## Build from source

Install [Rust](https://rustup.rs), [Bun](https://bun.sh), and
[`just`](https://github.com/casey/just), then run:

```sh
git clone https://github.com/buntec/btmux.git
cd btmux
just setup
cargo install --path .
```

## Shell completions

`btmux completions <shell>` prints a completion script for bash, fish, zsh,
PowerShell, or Elvish. Save it in your shell's completion directory. For example:

```sh
# fish
mkdir -p ~/.config/fish/completions
btmux completions fish > ~/.config/fish/completions/btmux.fish

# zsh: add ~/.zfunc to fpath before compinit runs in ~/.zshrc
mkdir -p ~/.zfunc
btmux completions zsh > ~/.zfunc/_btmux
```

```powershell
# PowerShell: load completions from your profile
if (!(Test-Path $PROFILE)) { New-Item -ItemType File -Force $PROFILE | Out-Null }
Add-Content $PROFILE 'btmux completions powershell | Out-String | Invoke-Expression'
```

Regenerate the script after updating btmux so it includes new commands and flags.

## Home Manager

The repository's flake exposes a Home Manager module, a CLI release package
(`packages.<system>.default`), and a desktop package (`packages.<system>.desktop`). The
module writes `config.toml`, installs btmux, and enables a per-user service by
default.

```nix
{
  inputs.btmux.url = "github:buntec/btmux";

  imports = [ inputs.btmux.homeManagerModules.default ];

  programs.btmux = {
    enable = true;
    settings = {
      prefix = "C-b";
      terminal.font-family = "JetBrains Mono";
      terminal.font-size = 16;
    };
    service = {
      host = "127.0.0.1";
      port = 8004;
      shell = "/bin/bash";
    };
  };
}
```

`services.btmux` is accepted as an alias for `programs.btmux`. The service uses
the same launchd label and systemd unit as `btmux install`, so `btmux restart`
works with it. When only the package changes, activation runs `btmux upgrade`,
so running shells survive; it falls back to a restart if the running server
can't upgrade in place, and restarts when the service's options change. If the
upgrade is refused or fails while the server keeps running (for example, with
unsaved Neovim buffers), activation only warns; run `btmux upgrade` later. If you used `btmux install` before, run `btmux uninstall` first. Set
`programs.btmux.service.enable = false` to install and configure btmux without
starting it. Override `package` to use a different build or package source, or
set it to `null` (with the service disabled) to only write the configuration.
When `programs.fish.enable` is set, the module also installs the btmux fish
theme (see [Configuration](configuration.md#fish-theme)); set
`enableFishIntegration = false` to skip it.
The module installs bash, fish, and zsh completions when the selected package
supports `btmux completions`. The bundled fallback package currently uses an
older release, so completions become available after selecting a newer package
or updating that release.

To also install the desktop app:

```nix
programs.btmux = {
  enable = true;
  desktop.enable = true;
  service.enable = false;
};
```

The desktop app runs its bundled server using the separate `desktop` profile.
It reads the same `config.toml`; it does not need the Home Manager background
service. Leave `service.enable = true` if you also want the browser service.
Both packages support Apple Silicon macOS and x86-64/ARM64 Linux. Override
`desktop.package` to select another desktop build. On macOS, Home Manager
makes the app available in `~/Applications/Home Manager Apps`; on Linux, it installs a
desktop menu entry. You can also launch it with `btmux-desktop`.

[Back to the README](../README.md)
