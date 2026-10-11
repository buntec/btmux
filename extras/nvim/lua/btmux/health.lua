-- `:checkhealth btmux`: plugins and settings that conflict with btmux's UI.
local M = {}

---@class btmux.Finding
---@field warn boolean A conflict, rather than a feature btmux can't apply.
---@field msg string
---@field advice? string

local function loaded(name)
  return package.loaded[name] ~= nil
end

local function blink_signature()
  local ok, config = pcall(require, "blink.cmp.config")
  return ok and type(config) == "table" and type(config.signature) == "table" and config.signature.enabled == true
end

local function scroll_animation()
  local snacks = package.loaded["snacks.scroll"]
  if type(snacks) == "table" and snacks.enabled then
    return "snacks.nvim's scroll"
  end
  local mini = rawget(_G, "MiniAnimate")
  if mini and vim.tbl_get(mini, "config", "scroll", "enable") then
    return "mini.animate's scroll"
  end
  if loaded("neoscroll") then
    return "neoscroll.nvim"
  end
end

---@return btmux.Finding[]
function M.findings()
  local btmux = require("btmux")
  local config = btmux.config or btmux.defaults
  local found = {}
  local function add(warn, msg, advice)
    found[#found + 1] = { warn = warn, msg = msg, advice = advice }
  end
  local skip = "Skip it when `vim.g.btmux` is set."

  if loaded("noice") then
    add(true, "noice.nvim draws its own cmdline, messages, and popups over btmux's.", skip)
  else
    -- Neovim's own is compiled in (`vim/_core/editor`) or loaded from $VIMRUNTIME.
    local source = debug.getinfo(vim.notify, "S").source:gsub("^@", "")
    if not (source:find("^vim/") or source:find("/lua/vim/", 1, true)) then
      add(true, "`vim.notify` is replaced (" .. source .. "), so notifications bypass btmux's toasts.", skip)
    end
  end
  local ui2 = package.loaded["vim._core.ui2"]
  if type(ui2) == "table" and ui2.cmd and vim.tbl_get(ui2, "cfg", "enable") ~= false then
    add(true, "ui2 draws the cmdline and messages in windows instead of btmux's UI.", skip)
  end
  if config.progress and loaded("fidget") then
    add(
      true,
      "fidget.nvim duplicates btmux's progress cards.",
      'Disable its progress, or btmux\'s with `require("btmux").setup({ progress = false })`.'
    )
  end
  if config.signature and (loaded("lsp_signature") or blink_signature()) then
    add(
      true,
      (loaded("lsp_signature") and "lsp_signature.nvim" or "blink.cmp's signature help")
        .. " duplicates btmux's signature help.",
      'Disable it, or btmux\'s with `require("btmux").setup({ signature = false })`.'
    )
  end
  local scroll = scroll_animation()
  if scroll then
    add(true, scroll .. " fights btmux's smooth scrolling.", skip)
  end
  if vim.o.mouse == "" then
    add(true, "'mouse' is empty, so clicks and the wheel do nothing.", "Set 'mouse' to `a`.")
  end
  if config.cmd_keys and vim.fn.has("clipboard") == 0 then
    add(true, 'No clipboard provider, so <D-c>, <D-x>, and `"+` fail.', "See `:help clipboard-tool`.")
  end
  if loaded("blink.cmp") or loaded("cmp") then
    add(
      false,
      (loaded("blink.cmp") and "blink.cmp" or "nvim-cmp")
        .. " draws its own completion menu; btmux's menu, docs, and kind icons only apply to native completion."
    )
  end
  return found
end

function M.check()
  vim.health.start("btmux")
  if not vim.g.btmux then
    return vim.health.info("Not running in btmux's built-in Neovim.")
  end
  local found = M.findings()
  if #found == 0 then
    vim.health.ok("No conflicts found.")
  end
  for _, f in ipairs(found) do
    if f.warn then
      vim.health.warn(f.msg, f.advice)
    else
      vim.health.info(f.msg)
    end
  end
end

--- Point out conflicts once, as a btmux toast.
function M.notify()
  local n = #vim.tbl_filter(function(f)
    return f.warn
  end, M.findings())
  if n > 0 then
    vim.notify(
      ("btmux: %d conflict%s with your config. See :checkhealth btmux"):format(n, n == 1 and "" or "s"),
      vim.log.levels.WARN
    )
  end
end

return M
