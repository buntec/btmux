# Installation

## Release installer

The installer supports Apple Silicon macOS and x86-64/ARM64 Linux. Intel macOS
is not currently supported.

```sh
curl -fsSL https://raw.githubusercontent.com/buntec/btmux/main/scripts/install.sh | bash
```

It downloads the latest release binary to `~/.local/bin`. Set
`BTMUX_INSTALL_DIR` to choose another location.

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
