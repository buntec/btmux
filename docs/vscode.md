# VS Code

With `editor = "vscode"`, `<prefix> + e` toggles VS Code over the active pane,
opened in the pane's folder. The other panes stay visible, and zooming the pane
(`<prefix> + z`) makes VS Code fill the window. Pressing Esc twice quickly also
hides it; on touch screens, the key bar has a button for that. There is one VS
Code server per btmux server. It reloads only when opened over a pane in another
folder.

```toml
editor = "vscode"
```

Requires macOS or Linux, and either VS Code or `openvscode-server` on the server
(see [Server](#server)). Webviews such as the Markdown preview need internet
access.

## Opening files

The file browser and Git mode open files in VS Code when `editor = "vscode"`.
`btmux open-editor [FILE] [LINE]` follows the same setting from a btmux pane.

With another `editor`, the status bar still has a button for VS Code when the
server can run it. `btmux open-editor --kind vscode` opens it from a pane, and
the `editor-vscode` action, unbound by default, toggles it from the command
palette or a `[keys]` binding.

## Server

```toml
[vscode]
server = "code"
```

`server` picks the server, read when it starts:

- `"code"` (default) runs `code serve-web` from an installed VS Code, found on
  the server's `PATH` or in `/Applications` on macOS. It downloads the matching
  server on first use. The first time, btmux asks you to accept the VS Code
  Server license (once per profile).
- `"openvscode-server"` uses `openvscode-server` from `PATH`.

User data and extensions are kept per profile, in a `vscode` directory beside
the [profile's state file](configuration.md#profiles-and-persistence).

## Sharing desktop settings and extensions

```toml
[vscode]
desktop = true
# settings = "~/.config/Code/User/settings.json"
# keybindings = "~/.config/Code/User/keybindings.json"
# extensions = ["~/.vscode/extensions"]
```

`desktop = true` shares desktop VS Code's user settings, keybindings, and
extensions: `settings.json` and `keybindings.json` from
`~/Library/Application Support/Code/User` (macOS) or
`$XDG_CONFIG_HOME/Code/User` (Linux), and the extensions in
`~/.vscode/extensions`. `settings`, `keybindings`, and `extensions` override
these paths (and work without `desktop`), for example for VSCodium or
Insiders; `extensions` lists extension folders or folders of them. Home
Manager's `programs.vscode` writes the default locations, so
`programs.btmux.settings.vscode.desktop = true` is all it takes.

Shared settings and keybindings are read each time a VS Code window loads and
replace the ones in btmux's VS Code, which keeps them in the browser, so
changes made there last only until the next load: edit desktop VS Code's
instead. Only its default profile is shared. Shared extensions are linked, not
copied, when VS Code starts; restart btmux to pick up new ones. Extensions you
install in btmux's VS Code stay, unless desktop VS Code has the same one.

## Color scheme and font

A bundled extension syncs btmux's color scheme and terminal font into VS Code,
over shared settings too; the editor uses the font at 80% of its size. Turn off
`btmux.syncTheme` or `btmux.syncFont` in VS Code's settings to keep your own.
