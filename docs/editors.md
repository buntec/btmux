# Editors

`<prefix> + e` opens the configured `editor` over the active pane, and the file
browser and Git mode open files there. Set `editor` in
[`config.toml`](configuration.md):

- `"neovim"`: a Neovim GUI drawn by btmux, with your config and with its command
  line, completion menu, messages, LSP signature help, and floating windows
  rendered as native UI. The default when Neovim 0.12 or newer is on the
  server's `PATH`; see [Neovim GUI](neovim.md).
- `"vscode"`: VS Code in the browser, using btmux's color scheme and font; see
  [VS Code](vscode.md).
- `"pane"`: the terminal: the pane's running Neovim, else `$EDITOR` in its
  shell. The default without Neovim 0.12.

Whatever `editor` says, the status bar shows a button for each editor the
server can run: Neovim 0.12+ and, outside Windows, the `[vscode] server`
program, found on the server's `PATH` (a service's `PATH` may be shorter than
your shell's) or, for VS Code on macOS, in `/Applications`. The configured editor comes first. The `editor-neovim` and
`editor-vscode` actions, unbound by default, toggle one of them from the
command palette or a `[keys]` binding, and `btmux open-editor --kind vscode`
opens one from a pane.
