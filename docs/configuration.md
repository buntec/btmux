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

## Replay and multiple viewers

Terminal scrollback in the browser still follows `[terminal].scrollback`. The
backend retains a separate output journal capped at 8 MiB per pane and 128 MiB
across journals. Evicting history advances a VT100 screen checkpoint, preserving
the visible screen and standard input modes while releasing older history.
Replay includes ordered resize events and never clears history on a resize.
The cap covers retained journal data, not total process or browser memory.

The checkpoint covers standard VT100 text, attributes, cursor, alternate screen,
and supported input modes. Ghostty-specific graphics and unsupported terminal
extensions are preserved in recent raw output but are not guaranteed after that
output is compacted into a checkpoint. Full compatibility with every Ghostty
extension would require a matching server-side Ghostty state serializer.

The first connected interactive viewer controls the shared PTY size; other
viewers adopt it. On disconnect, ownership passes to the oldest remaining viewer.
Mirrors never own dimensions or send input. Window and pane selection remain
shared per session, while session navigation remains local to each browser.
