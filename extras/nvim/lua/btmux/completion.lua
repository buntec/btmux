-- Completion docs. Neovim updates an item's documentation through the internal
-- `nvim__complete_set` (e.g. after LSP `completionItem/resolve`) without telling
-- external UIs; forward it, and hide Neovim's own documentation float, which btmux
-- draws beside its popupmenu instead.
local M = {}

local api = vim.api

local function hide_win(winid)
  if winid and winid > 0 and api.nvim_win_is_valid(winid) then
    pcall(api.nvim_win_set_config, winid, { hide = true })
  end
end

function M.setup()
  local complete_set = api.nvim__complete_set
  if not complete_set then
    return
  end
  local notify = require("btmux").notify
  api.nvim__complete_set = function(index, opts)
    local result = complete_set(index, opts)
    if opts and opts.info then
      notify("btmux_complete_info", index, opts.info)
    end
    hide_win(result and result.winid)
    return result
  end
  api.nvim_create_autocmd("CompleteChanged", {
    group = api.nvim_create_augroup("btmux_completion", {}),
    callback = function()
      hide_win(vim.fn.complete_info({ "preview_winid" }).preview_winid)
    end,
  })
end

return M
