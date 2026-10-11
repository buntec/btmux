-- Completion kind icons from mini.icons (if set up), shown by btmux in its popupmenu.
-- The UI asks for them with `icons()` after attaching; colorscheme changes push an update.
local M = {}

local api = vim.api

M.enabled = false

--- Map of LSP kind name ("Function", …) to { icon, color }; empty without mini.icons.
function M.icons()
  local icons = vim.empty_dict()
  local MiniIcons = rawget(_G, "MiniIcons")
  if not M.enabled or not MiniIcons then
    return icons
  end
  for _, kind in ipairs(vim.lsp.protocol.CompletionItemKind) do
    local glyph, hl = MiniIcons.get("lsp", kind:lower())
    local fg = api.nvim_get_hl(0, { name = hl, link = false }).fg
    icons[kind] = { icon = glyph, color = fg and ("#%06x"):format(fg) or vim.NIL }
  end
  return icons
end

function M.setup()
  M.enabled = true
  api.nvim_create_autocmd("ColorScheme", {
    group = api.nvim_create_augroup("btmux_kinds", {}),
    callback = function()
      require("btmux").notify("btmux_kind_icons", M.icons())
    end,
  })
end

return M
