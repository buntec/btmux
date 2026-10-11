-- Progress, shown by btmux as cards in the corner. LSP `$/progress` becomes a
-- progress-message (`nvim_echo` kind "progress"), and every progress-message
-- (LSP, `:write`, `vim.pack`, …) is forwarded with its title, status and percent,
-- which `msg_show` doesn't carry.
local M = {}

local api = vim.api

-- Progress text arrives as a list of chunks (strings or `[text, hl]` pairs).
local function flatten(text)
  if type(text) ~= "table" then
    return text or ""
  end
  local parts = {}
  for _, chunk in ipairs(text) do
    parts[#parts + 1] = type(chunk) == "table" and chunk[1] or chunk
  end
  return table.concat(parts)
end

function M.setup()
  local notify = require("btmux").notify
  local group = api.nvim_create_augroup("btmux_progress", {})
  api.nvim_create_autocmd("LspProgress", {
    group = group,
    callback = function(ev)
      local value = ev.data.params.value
      if type(value) ~= "table" then
        return
      end
      local client = vim.lsp.get_client_by_id(ev.data.client_id)
      api.nvim_echo({ { value.message or "" } }, false, {
        id = ("btmux.lsp.%d.%s"):format(ev.data.client_id, tostring(ev.data.params.token)),
        kind = "progress",
        title = value.title,
        source = client and client.name or "lsp",
        status = value.kind == "end" and "success" or "running",
        percent = value.percentage,
      })
    end,
  })
  api.nvim_create_autocmd("Progress", {
    group = group,
    callback = function(ev)
      local data = ev.data
      notify("btmux_progress", {
        id = tostring(data.id),
        text = vim.trim(flatten(data.text)),
        title = data.title or "",
        source = data.source or "",
        status = data.status or "running",
        percent = data.percent or vim.NIL,
      })
    end,
  })
end

return M
