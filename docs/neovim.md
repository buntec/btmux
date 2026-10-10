# Built-in Neovim

`<prefix> + e` opens a Neovim GUI over the current session. btmux draws the
editor itself and renders the command line, completion menu, messages, progress,
and LSP signature help as native UI. There is one Neovim per btmux server, so
every browser tab and the desktop app share the same editor. `<prefix> + e`
hides it again; `:q` closes Neovim and the view.

Requires Neovim 0.12 or newer as `nvim` on the server's `PATH`.

## Opening files

The file browser and Git mode open files in the built-in Neovim. To open them in
the pane instead (its running Neovim, or `$EDITOR` in its shell), set:

```toml
file-editor = "pane"
```

## Your Neovim config

btmux starts Neovim with your normal config and sets `g:btmux`, so you can adapt
it to the GUI:

```lua
if vim.g.btmux then
  -- btmux animates each scroll; single-line steps feel smoothest
  vim.o.mousescroll = "ver:1,hor:6"
end
```

Plugins that draw their own completion menus or animate scrolling (such as
blink.cmp or snacks.nvim's `scroll`) keep working but bypass or fight btmux's UI.
Native completion goes through btmux's menu, including item docs:

```lua
if vim.g.btmux then
  vim.o.autocomplete = true
  vim.o.completeopt = "menuone,noselect,fuzzy,popup"
  vim.api.nvim_create_autocmd("LspAttach", {
    callback = function(ev)
      vim.lsp.completion.enable(true, ev.data.client_id, ev.buf, { autotrigger = true })
    end,
  })
end
```

## The btmux plugin

btmux bundles a Neovim plugin and loads it automatically. Call `setup` in your
config to change its defaults:

```lua
require("btmux").setup({
  completion_docs = true, -- item docs beside the completion menu
  signature = { keymap = "<C-s>" }, -- LSP signature help; false to disable
  progress = true, -- LSP, :write, and other progress as cards
  kind_icons = true, -- completion kind icons from mini.icons
  cmd_keys = true, -- <D-c>/<D-x> copy/cut a selection, <D-s> writes
})
```

## Fonts, scrolling, and keys

The view uses the terminal font. Neovim's `guifont` and `linespace` override it,
for example `:set guifont=JetBrains\ Mono:h14`. Scrolling animates for
`[terminal] smooth-scroll-duration` (default 120 ms) unless `animations = false`.

F-keys and Cmd shortcuts reach Neovim as `<F5>` or `<D-s>`. Cmd+Q, W, T, N, R,
L, M, H, Cmd+digits, and Cmd+V (paste) stay with the browser or desktop app.

## Limitations

- Neovim sizes its grid to the smallest view attached to it.
- Plugin floats (LSP hover, diagnostics) are drawn in the grid, not as btmux UI.
- `"+` registers use the clipboard of the machine btmux runs on.
