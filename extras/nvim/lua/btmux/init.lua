-- btmux UI support for the built-in Neovim. btmux puts this plugin on 'runtimepath'
-- and sets `g:btmux`; `plugin/btmux.lua` calls `setup()` unless your config already did.
local M = {}

---@class btmux.Config
---@field completion_docs? boolean Show completion item docs beside btmux's popupmenu.
---@field signature? false|{ keymap?: string|false } LSP signature help; `keymap` opens it on demand.
---@field progress? boolean Show LSP and other progress-messages as btmux progress cards.
---@field cmd_keys? boolean GUI-style Cmd shortcuts: <D-c>/<D-x> copy/cut a selection, <D-s> writes.
---@field kind_icons? boolean Completion kind icons from mini.icons in btmux's popupmenu.
---@field check? boolean Warn once at startup if `:checkhealth btmux` finds conflicts.
M.defaults = {
  completion_docs = true,
  signature = { keymap = "<C-s>" },
  progress = true,
  cmd_keys = true,
  kind_icons = true,
  check = true,
}

---@param opts? btmux.Config
function M.setup(opts)
  if vim.g.btmux_setup then
    return
  end
  vim.g.btmux_setup = true
  local config = vim.tbl_deep_extend("force", M.defaults, opts or {})
  M.config = config
  if config.completion_docs then
    require("btmux.completion").setup()
  end
  if config.signature then
    require("btmux.signature").setup(config.signature)
  end
  if config.progress then
    require("btmux.progress").setup()
  end
  if config.kind_icons then
    require("btmux.kinds").setup()
  end
  if config.cmd_keys then
    -- Keep mappings from your config.
    local function map(mode, lhs, rhs, desc)
      if vim.fn.maparg(lhs, mode) == "" then
        vim.keymap.set(mode, lhs, rhs, { desc = desc })
      end
    end
    map("x", "<D-c>", '"+y', "Copy (btmux)")
    map("x", "<D-x>", '"+d', "Cut (btmux)")
    map("n", "<D-s>", "<Cmd>write<CR>", "Write (btmux)")
    map("i", "<D-s>", "<Cmd>write<CR>", "Write (btmux)")
  end
  if config.check then
    -- After the first UI attaches and lazy-loaded plugins (e.g. lazy.nvim's VeryLazy) set up.
    vim.api.nvim_create_autocmd("UIEnter", {
      once = true,
      callback = function()
        vim.defer_fn(require("btmux.health").notify, 1000)
      end,
    })
  end
end

--- Send a notification to btmux UIs. Other clients ignore unknown notifications.
function M.notify(method, ...)
  vim.rpcnotify(0, method, ...)
end

return M
