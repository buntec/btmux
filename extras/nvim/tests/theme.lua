local theme = require("btmux.theme")
local palette = {}
for i = 0, 23 do
  palette[string.format("base%02X", i)] = string.format("#%06x", i * 0x070707)
end
local function hl(name)
  return vim.api.nvim_get_hl(0, { name = name, link = false })
end
local function color(slot)
  return tonumber(palette[slot]:sub(2), 16)
end

local changes = 0
vim.api.nvim_create_autocmd("ColorScheme", {
  callback = function()
    changes = changes + 1
  end,
})
theme.apply(palette, false)
assert(vim.g.colors_name == "btmux")
assert(vim.o.background == "dark")
assert(hl("Normal").fg == color("base05") and hl("Normal").bg == color("base00"))
assert(hl("Comment").fg == color("base03"))
assert(hl("@function").fg == color("base0D"))
assert(hl("Special").fg == color("base0F"))
assert(hl("DiagnosticUnderlineError").sp == color("base08"))
assert(hl("NormalFloat").bg == color("base10"))
assert(hl("DiffAdd").bg == color("base11"))
assert(vim.g.terminal_color_9 == palette.base12)
assert(vim.g.terminal_color_12 == palette.base16)

vim.api.nvim_set_hl(0, "Comment", { fg = "#123456" })
theme.apply(vim.deepcopy(palette), false)
assert(changes == 1 and hl("Comment").fg == 0x123456, "identical tabs must preserve custom highlights")
theme.apply(palette, true)
assert(hl("Normal").bg == nil and hl("NormalNC").bg == nil)
assert(hl("Visual").bg == color("base02"))
assert(hl("NormalFloat").bg == color("base10"))
vim.cmd.colorscheme("btmux")
assert(hl("Normal").bg == nil, "manual reload preserves transparency")

-- A partial Base24 extension must use Base16 fallbacks throughout.
palette.base17 = nil
theme.apply(palette, false)
assert(hl("NormalFloat").bg == color("base00"))
assert(hl("DiffAdd").bg == color("base01"))
assert(vim.g.terminal_color_9 == palette.base08)
assert(vim.g.terminal_color_12 == palette.base0D)
palette.base00 = "#ffffff"
theme.apply(palette, false)
assert(vim.o.background == "light" and hl("Normal").bg == 0xffffff)
for i = 16, 23 do
  palette[string.format("base%02X", i)] = vim.NIL
end
theme.apply(palette, true)
assert(vim.g.terminal_color_9 == palette.base08)
theme.apply(vim.deepcopy(palette), true)
assert(hl("Normal").bg == nil)
print("PASS Base16/24 highlights, transparency, reload, and light themes")
