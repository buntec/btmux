# Configuration

btmux creates a configuration file on first launch:

```text
~/.config/btmux/config.toml
```

It respects `$XDG_CONFIG_HOME`, all fields are optional, and changes are picked
up live. Run the following command for the complete documented set of options:

```sh
btmux generate-config
```

## Appearance

Press `<prefix> + :` and choose `config: open appearance settings` to open the
browser-based editor. Applying a change creates a process-local preview; the
editor never writes `config.toml`. Preview overrides disappear when btmux
restarts or the config file reloads. Use the editor's generated TOML and copy
action to persist your choices.

Configuration includes terminal options, session and window sort order, pane
title bars, vi-style navigation, bundled font families and weights, image or
procedural wallpapers, and steady-state, session-switch, and pane-switch WebGL
effects.

The `colors` option accepts either:

- the name of a base16/base24 YAML file in `~/.config/btmux/colors/`; or
- an `http://` or `https://` URL to a YAML palette.

Palettes may be defined at the top level or nested under `palette`. Remote
palettes are fetched whenever the configuration loads.

## Profiles and persistence

By default, session structure is saved to
`~/.local/state/btmux/state.json` (respecting `$XDG_STATE_HOME`). Named profiles
let you run isolated instances, each with separate state:

```sh
btmux --profile work --port 8005
btmux --profile personal --port 8006
```

Profile state is stored under `$XDG_STATE_HOME/btmux/<profile>/state.json`, or
`~/.local/state/btmux/<profile>/state.json` when `XDG_STATE_HOME` is unset. The
default profile continues to use the top-level `state.json`.

Persistence covers the session/window/pane tree, layouts, names, active
indices, and each pane's last-known working directory. Running shell processes
and scrollback do not survive a btmux restart. Restored panes lazily start fresh
shells in their saved working directories.

[Back to the README](../README.md)
