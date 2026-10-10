-- btmux UI support for the built-in Neovim. btmux puts this plugin on 'runtimepath'
-- and sets `g:btmux`; `plugin/btmux.lua` calls `setup()` unless your config already did.
local M = {}

---@class btmux.Config
---@field completion_docs? boolean Show completion item docs beside btmux's popupmenu.
---@field signature? false|{ keymap?: string|false } LSP signature help; `keymap` opens it on demand.
---@field progress? boolean Show LSP and other progress-messages as btmux progress cards.
---@field cmd_keys? boolean GUI-style Cmd shortcuts: <D-c>/<D-x> copy/cut a selection, <D-s> writes.
---@field kind_icons? boolean Completion kind icons from mini.icons in btmux's popupmenu.
M.defaults = {
  completion_docs = true,
  signature = { keymap = "<C-s>" },
  progress = true,
  cmd_keys = true,
  kind_icons = true,
}

---@param opts? btmux.Config
function M.setup(opts)
  if vim.g.btmux_setup then
    return
  end
  vim.g.btmux_setup = true
  local config = vim.tbl_deep_extend("force", M.defaults, opts or {})
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
    vim.keymap.set("x", "<D-c>", '"+y', { desc = "Copy (btmux)" })
    vim.keymap.set("x", "<D-x>", '"+d', { desc = "Cut (btmux)" })
    vim.keymap.set({ "n", "i" }, "<D-s>", "<Cmd>write<CR>", { desc = "Write (btmux)" })
  end
end

--- Send a notification to btmux UIs. Other clients ignore unknown notifications.
function M.notify(method, ...)
  vim.rpcnotify(0, method, ...)
end

return M
