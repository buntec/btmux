# btmux.nvim

Open the btmux file/Git browser (`prefix + f` / `prefix + g`) from Neovim, at a
given directory, in whichever btmux pane you're editing from. Selecting a file
there opens it back in this same Neovim instance (jumping to the selected
line), via btmux's `--remote-expr` call to Neovim's RPC server.

Requires Neovim running inside a btmux pane, which sets `BTMUX_PANE_ID`,
`BTMUX_API_URL`, and `BTMUX_AUTH_TOKEN` in its environment.

## Install

With [lazy.nvim](https://github.com/folke/lazy.nvim), pointing at a local
checkout of btmux:

```lua
{
  dir = '~/repos/btmux/extras/neovim/btmux.nvim',
  keys = {
    { '<leader>-', function() require('btmux').open_file_browser() end, desc = 'btmux: open file browser here' },
    { '<leader>g-', function() require('btmux').open_file_browser(nil, 'git') end, desc = 'btmux: open git view here' },
  },
},
```

Or call `setup()` to install the default keymaps (`<leader>-` and
`<leader>g-`), overriding any you want to change or disable:

```lua
{
  dir = '~/repos/btmux/extras/neovim/btmux.nvim',
  opts = {},
},
```

With [packer.nvim](https://github.com/wbthomason/packer.nvim):

```lua
use({ '~/repos/btmux/extras/neovim/btmux.nvim', config = function()
  require('btmux').setup()
end })
```

Or add `extras/neovim/btmux.nvim` to `runtimepath` yourself and call
`require('btmux').setup()` from `init.lua`.

## Usage

- `require('btmux').open_file_browser(dir?, mode?)` — `dir` defaults to the
  current buffer's directory, `mode` is `'files'` (default) or `'git'`.
- `:BtmuxOpenFileBrowser [dir]`, `:BtmuxOpenGitBrowser [dir]` — same, as
  user commands.

## Configuration

```lua
require('btmux').setup({
  keymaps = {
    open_file_browser = '<leader>-', -- set to false to skip this keymap
    open_git_browser = '<leader>g-',
  },
})
```
