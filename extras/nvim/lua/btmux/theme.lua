-- Base16/24 colors supplied by btmux on UI attach and config changes.
local M = {}

function M.apply(palette, transparent)
  if
    vim.g.colors_name == "btmux"
    and vim.deep_equal(vim.g.btmux_palette, palette)
    and vim.g.btmux_transparent == transparent
  then
    return
  end
  vim.g.btmux_palette = palette
  vim.g.btmux_transparent = transparent
  vim.cmd.colorscheme("btmux")
end

function M.load()
  local p = vim.g.btmux_palette
  if not p then
    return
  end
  local base24 = true
  for i = 16, 23 do
    base24 = base24 and type(p[string.format("base%02X", i)]) == "string"
  end
  local bg = vim.g.btmux_transparent and "NONE" or p.base00
  local deep = base24 and p.base10 or p.base00
  local deepest = base24 and p.base11 or p.base01
  local r, g, b = p.base00:match("#?(%x%x)(%x%x)(%x%x)")
  vim.g.colors_name = nil
  if r then
    local light = 0.2126 * tonumber(r, 16) + 0.7152 * tonumber(g, 16) + 0.0722 * tonumber(b, 16) > 128
    vim.o.background = light and "light" or "dark"
  end
  vim.cmd.highlight("clear")
  vim.g.colors_name = "btmux"

  local function hi(names, fg, background, style)
    for name in names:gmatch("%S+") do
      vim.api.nvim_set_hl(0, name, vim.tbl_extend("force", { fg = fg, bg = background }, style or {}))
    end
  end
  local function link(names, target)
    for name in names:gmatch("%S+") do
      vim.api.nvim_set_hl(0, name, { link = target })
    end
  end

  hi("Normal NormalNC", p.base05, bg)
  hi("NormalFloat", p.base05, deep)
  hi("FloatBorder FloatTitle", p.base0D, deep)
  hi("Comment", p.base03, nil, { italic = true })
  hi("Constant Number Boolean Float", p.base09)
  hi("String", p.base0B)
  hi("Character", p.base08)
  hi("Identifier", p.base08)
  hi("Function", p.base0D)
  hi("Statement Conditional Repeat Keyword Exception", p.base0E)
  hi("Operator", p.base05)
  hi("PreProc Include Define Macro PreCondit", p.base0A)
  hi("Type StorageClass Structure Typedef", p.base0A)
  hi("Special SpecialChar SpecialComment Debug", p.base0F)
  hi("Delimiter", p.base05)
  hi("Tag", p.base08)
  hi("Underlined", p.base0D, nil, { underline = true })
  hi("Ignore", p.base03)
  hi("Error", p.base08, nil, { bold = true })
  hi("Todo", p.base0A, p.base01, { bold = true })

  hi("Cursor lCursor TermCursor", p.base00, p.base05)
  hi("CursorLine CursorColumn", nil, p.base01)
  hi("ColorColumn", nil, p.base01)
  hi("LineNr LineNrAbove LineNrBelow", p.base03, bg)
  hi("CursorLineNr", p.base0A, bg, { bold = true })
  hi("SignColumn FoldColumn", p.base03, bg)
  hi("Folded", p.base03, p.base01)
  hi("NonText EndOfBuffer Whitespace SpecialKey", p.base03)
  hi("Visual VisualNOS", nil, p.base02)
  hi("Search", p.base00, p.base0A)
  hi("IncSearch CurSearch", p.base00, p.base09)
  hi("MatchParen", p.base0C, p.base02, { bold = true })
  hi("Pmenu", p.base05, p.base01)
  hi("PmenuSel", p.base05, p.base02)
  hi("PmenuSbar", nil, p.base02)
  hi("PmenuThumb", nil, p.base04)
  link("PmenuKind PmenuExtra PmenuMatch", "Pmenu")
  link("PmenuKindSel PmenuExtraSel PmenuMatchSel", "PmenuSel")
  hi("StatusLine", p.base05, p.base02)
  hi("StatusLineNC WinBarNC", p.base04, p.base01)
  hi("WinBar", p.base05, bg)
  hi("WinSeparator", p.base02, bg)
  hi("TabLine TabLineFill", p.base03, p.base01)
  hi("TabLineSel", p.base05, p.base02)
  hi("Title Directory", p.base0D)
  hi("ErrorMsg", p.base08)
  hi("WarningMsg", p.base09)
  hi("ModeMsg MoreMsg Question", p.base0B)
  hi("DiffAdd", p.base0B, deepest)
  hi("DiffChange", p.base0A, deep)
  hi("DiffDelete", p.base08, deepest)
  hi("DiffText", p.base0D, p.base02)
  hi("Added", p.base0B)
  hi("Changed", p.base0A)
  hi("Removed", p.base08)

  for name, color in pairs({ Error = p.base08, Warn = p.base0A, Info = p.base0D, Hint = p.base0C, Ok = p.base0B }) do
    hi("Diagnostic" .. name .. " DiagnosticSign" .. name .. " DiagnosticVirtualText" .. name, color)
    hi("DiagnosticFloating" .. name, color, deep)
    hi("DiagnosticUnderline" .. name, nil, nil, { sp = color, undercurl = true })
  end
  for name, color in pairs({ Bad = p.base08, Cap = p.base0D, Local = p.base0C, Rare = p.base0E }) do
    hi("Spell" .. name, nil, nil, { sp = color, undercurl = true })
  end
  hi("GitSignsAdd", p.base0B)
  hi("GitSignsChange", p.base0A)
  hi("GitSignsDelete", p.base08)

  link("@comment @comment.documentation", "Comment")
  link("@string @string.documentation", "String")
  link("@string.escape @string.regexp", "SpecialChar")
  link("@character @character.special", "Character")
  link("@number @number.float @boolean", "Number")
  link("@constant @constant.builtin", "Constant")
  link("@constant.macro", "Macro")
  hi("@variable", p.base05)
  hi("@variable.builtin", p.base08)
  hi("@variable.parameter", p.base09)
  hi("@variable.member @property", p.base08)
  link("@function @function.call @function.method @function.method.call @function.builtin", "Function")
  link("@function.macro", "Macro")
  link("@constructor @type @type.builtin @type.definition @module", "Type")
  link(
    "@keyword @keyword.function @keyword.return @keyword.operator @keyword.conditional @keyword.repeat @keyword.exception",
    "Keyword"
  )
  link("@keyword.import @attribute", "PreProc")
  link("@operator @punctuation.delimiter @punctuation.bracket", "Operator")
  link("@punctuation.special @tag.delimiter", "Special")
  link("@tag", "Tag")
  link("@tag.attribute", "Identifier")
  hi("@markup.heading", p.base0D, nil, { bold = true })
  hi("@markup.strong", nil, nil, { bold = true })
  hi("@markup.italic", nil, nil, { italic = true })
  hi("@markup.strikethrough", nil, nil, { strikethrough = true })
  link("@markup.link @markup.link.url", "Underlined")
  link("@markup.raw", "String")
  link("@lsp.type.variable", "@variable")
  link("@lsp.type.parameter", "@variable.parameter")
  link("@lsp.type.property", "@variable.member")
  link("@lsp.type.function @lsp.type.method", "Function")
  link(
    "@lsp.type.class @lsp.type.enum @lsp.type.interface @lsp.type.struct @lsp.type.type @lsp.type.typeParameter",
    "Type"
  )
  link("@lsp.type.namespace", "@module")
  link("@lsp.type.enumMember", "Constant")
  link("@lsp.type.comment", "Comment")
  link("@lsp.type.keyword", "Keyword")
  hi("LspReferenceText LspReferenceRead LspReferenceWrite", nil, p.base02)
  hi("LspInlayHint", p.base03, p.base01)

  local ansi = {
    p.base00,
    p.base08,
    p.base0B,
    p.base0A,
    p.base0D,
    p.base0E,
    p.base0C,
    p.base05,
    p.base03,
    base24 and p.base12 or p.base08,
    base24 and p.base14 or p.base0B,
    base24 and p.base13 or p.base0A,
    base24 and p.base16 or p.base0D,
    base24 and p.base17 or p.base0E,
    base24 and p.base15 or p.base0C,
    p.base07,
  }
  for i, color in ipairs(ansi) do
    vim.g["terminal_color_" .. (i - 1)] = color
  end
end

return M
