# Configuration

btmux creates a configuration file on first launch:

```text
~/.config/btmux/config.toml
```

It respects `$XDG_CONFIG_HOME`, all fields are optional, and most changes are
picked up live. Log-level changes take effect after a restart. If the file
can't be parsed, btmux keeps the last valid configuration (the defaults at
startup) and shows a banner until the file is fixed; its Show error button opens
the full message. Run the following
command for the complete documented set of options:

```sh
btmux generate-config
```

## Appearance

Press `<prefix> + :` and choose `config: open settings` to open the
browser-based editor. Applying a change creates a process-local preview; the
editor never writes `config.toml`. Preview overrides disappear when btmux
restarts or the config file reloads. Use the editor's generated TOML and copy
action to persist your choices.

Configuration includes terminal options, session and window sort order, pane
title bars, vi-style navigation, bundled font families and weights, image or
procedural wallpapers, and steady-state, session-switch, and pane-switch WebGL
effects.

The `[terminal]` `font-family` and `font-weight` set the terminal, the Neovim
GUI, and code-like UI text such as paths, session and window names, and key
hints. Other UI text uses Geist Sans.

Wallpapers are disabled by default. Set `wallpaper` to an image URL or path,
or add `[[wallpaper-shader]]` layers to stack shaders and effects (see
[Shader wallpapers](shaders.md)).

btmux checks GitHub for newer releases about once a day and shows a toast when
one is available. It never downloads or installs anything; upgrade with whatever
method you installed with. Set `check-for-updates = false` to turn the check off.

btmux has a dark and a light color scheme. `appearance` picks which one is
shown: `"auto"` (the default) follows the system setting of the browser that
connected or was focused last, while `"dark"` and `"light"` pin one. The same
scheme is shown in every tab and reported to programs in panes. The sidebar's
appearance button and the `choose-appearance` command switch it for the
session.

```toml
appearance = "auto"
colors-dark = "kauz-dark"
colors-light = "kauz-light"
```

`colors-dark` (default `btmux-default-dark`) and `colors-light` (default
`btmux-default-light`) accept:

- the name of a bundled scheme: `btmux-default-dark`, `btmux-default-light`,
  `kauz-dark`, or `kauz-light`;
- the name of a base16/base24 YAML file in `$XDG_CONFIG_HOME/btmux/colors/`
  (falling back to `~/.config/btmux/colors/`), which takes precedence over a
  bundled scheme of the same name. The name is the filename without its
  `.yaml` or `.yml` extension; files with other extensions are ignored;
- an absolute or `~/`-relative local YAML path; or
- an `http://` or `https://` URL to a YAML palette.

An inline `[theme-dark]` or `[theme-light]` table of `base00`–`base0F` (and
optionally `base10`–`base17`) overrides the matching option.

Palettes may be defined at the top level or nested under `palette`. They must
contain `base00`–`base0F`; a file without them is skipped with a warning in the
server log. A palette is base24 only if it also has all of `base10`–`base17`;
with any of them missing it is treated as base16. Remote palettes are fetched
whenever the configuration loads.

Schemes in the colors directory and the bundled schemes appear in the colors
picker of the command palette, which sets the scheme of the mode currently
shown, and in Settings. Changes there are session-only; set `appearance`,
`colors-dark`, or `colors-light` in `config.toml` to keep them.

Programs in a pane can query the scheme: btmux answers OSC 4/10/11/12 color
queries and `CSI ? 996 n`, and sends `CSI ? 997 ; 1|2 n` to programs that
enabled mode 2031 whenever the theme changes, including when `appearance`
switches between dark and light. Fish uses this to set
`fish_terminal_color_theme` and switch light/dark theme variants.

### Fish theme

```sh
btmux install-fish-theme   # or: btmux generate-fish-theme > btmux.theme
```

This writes `~/.config/fish/themes/btmux.theme` and `conf.d/btmux.fish` (respecting
`$XDG_CONFIG_HOME`). The theme uses named ANSI colors following base16 roles, so
it tracks the btmux scheme, including live changes. The snippet selects it only
inside btmux panes and overrides universal `fish_color_*` variables there. The
Home Manager module installs both files when `programs.fish.enable` is set.

## tmux behaviors

Kill confirmation, send-prefix, pane resizing, and `repeat-time` are described in
[btmux for tmux users](tmux.md).

## Editor

`editor` chooses the editor that `<prefix> + e`, the file browser, and Git
mode open: `"neovim"` (your Neovim in btmux's GUI over the pane), `"vscode"`
(VS Code in the browser over the pane), or `"pane"` (the terminal: the pane's
running Neovim, else `$EDITOR` in its shell). The default is `"neovim"` when
Neovim 0.12 or newer is on the server's `PATH`, else `"pane"`. See
[Neovim GUI](neovim.md).

With `"vscode"`, `<prefix> + e` toggles VS Code over the active pane, opened
in the pane's folder; pressing Esc twice quickly also hides it. The first time,
btmux asks you to accept the VS Code Server license (once per profile).
`vscode-server` picks the server, read when it starts: `"code"` (default) runs
`code serve-web` from an installed VS Code, which downloads the matching server
on first use; `"openvscode-server"` uses `openvscode-server` from `PATH`. A
bundled extension syncs btmux's color scheme and terminal font into VS Code;
turn off `btmux.syncTheme` or `btmux.syncFont` in VS Code's settings to keep
your own. Webviews such as the Markdown preview need internet access.

## LaTeX overlay

btmux scans the visible part of each pane for LaTeX: `$$…$$`, `\[…\]`,
`\(…\)`, `\begin{equation}`-style environments, `$…$`, and the bare `[` / `]`
blocks and `( … )` spans some coding agents print after their Markdown renderer
drops the backslashes. When it finds any, a `∑ N` chip appears in the pane's
title bar (or its top-right corner when title bars are off).

Click the chip, press `<prefix> + m`, or run `latex: toggle overlay` from the
command palette to open a side panel with the formulas rendered by KaTeX.
Hovering a formula highlights its source in the terminal. Rebind the key with
`toggle-latex` under `[keys]`.

Detection is heuristic. Shell text such as `$HOME/bin:$PATH` is filtered out,
and anything KaTeX cannot parse is dropped silently.

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
shells in their saved working directories. `btmux upgrade` moves a running
server to a new binary without a restart, keeping both.

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
