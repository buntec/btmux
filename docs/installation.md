# Installation

## Release installer

The installer supports Apple Silicon macOS and x86-64/ARM64 Linux. Intel macOS
is not currently supported.

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

It downloads the latest release binary to `~/.local/bin`. Set
`BTMUX_INSTALL_DIR` to choose another location.

## Access tokens and reverse proxies

### First sign-in

Start `btmux`, then open `http://localhost:8004`. Access requires a token even
on localhost. Unless `BTMUX_AUTH_TOKEN` is set, btmux creates an owner-only
`state.token` beside the profile's `state.json` and prints its path on startup.

| Instance | Default token file |
| --- | --- |
| `btmux` | `~/.local/state/btmux/state.token` |
| `btmux --profile NAME` | `~/.local/state/btmux/NAME/state.token` |
| `just dev` / `just dev-backend` | `~/.local/state/btmux/dev/state.token` |

These paths apply on both macOS and Linux. If `XDG_STATE_HOME` is set, it replaces
`~/.local/state`. For the default instance, read the token with:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/btmux/state.token"
```

Enter `btmux` as the browser username and the file's contents as the password.
The development frontend at `http://localhost:5173` instead shows an access-token
form; paste the `dev` profile's token there. A background service uses the same
file locations, so you can retrieve its token without reading service logs.

### Token management

Tokens survive restarts. To rotate a generated token, stop the server, delete
its token file, and restart it to generate a new one. Alternatively, start the
server with `BTMUX_AUTH_TOKEN` set to at least 32 ASCII letters, digits, `-`, or
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

## Background service

btmux can install itself as a per-user service that starts at login and restarts
after a crash. It uses a launchd LaunchAgent on macOS and a systemd user unit on
Linux.

```sh
btmux install              # install and start on 127.0.0.1:8004
btmux --port 8004 install  # bake command-line options into the service
btmux install --print      # print the unit without installing it
btmux restart              # restart the installed service
btmux uninstall            # stop and remove the service
```

The `--host`, `--port`, `--profile`, and `--shell` flags, along with your
shell's `PATH`, are captured when the service is installed. Re-run
`btmux install` after changing them.

Install the service from a stable binary path such as `~/.local/bin/btmux`.
Using a `target/` build artifact will break the service after `cargo clean` or a
rebuild that replaces the binary.

## Build from source

Install [Rust](https://rustup.rs), [Bun](https://bun.sh), and
[`just`](https://github.com/casey/just), then run:

```sh
git clone https://github.com/buntec/btmux.git
cd btmux
just setup
cargo install --path .
```

## Home Manager

The repository's flake exposes a Home Manager module and release package. The
module writes `config.toml`, installs btmux, and enables a per-user service by
default.

```nix
{
  inputs.btmux.url = "github:buntec/btmux";

  imports = [ inputs.btmux.homeManagerModules.default ];

  programs.btmux = {
    enable = true;
    settings = {
      prefix = "C-a";
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

`services.btmux` is accepted as an alias for `programs.btmux`. Set
`programs.btmux.service.enable = false` to install and configure btmux without
starting it. Override `package` to use a different build or package source.

[Back to the README](../README.md)
