-- LSP signature help, shown by btmux beside the cursor while typing a call.
local M = {}

local api = vim.api
local notify = require("btmux").notify

local shown = false
local generation = 0

local function hide()
  generation = generation + 1
  if shown then
    shown = false
    notify("btmux_signature", vim.NIL)
  end
end

local function markup(value)
  if type(value) == "table" then
    return value.value or ""
  end
  return value or ""
end

local function show(result)
  local signatures = result and result.signatures or {}
  if #signatures == 0 then
    return hide()
  end
  local index = math.min((result.activeSignature or 0) + 1, #signatures)
  local sig = signatures[index]
  local active = sig.activeParameter or result.activeParameter or 0
  local param = (sig.parameters or {})[active + 1]
  local cursor = api.nvim_win_get_cursor(0)
  local pos = vim.fn.screenpos(0, cursor[1], cursor[2] + 1)
  shown = true
  notify("btmux_signature", {
    label = sig.label,
    -- A substring or [start, end) UTF-16 offsets into the label.
    param = param and param.label or vim.NIL,
    param_doc = param and markup(param.documentation) or "",
    doc = markup(sig.documentation),
    index = index,
    count = #signatures,
    row = pos.row - 1,
    col = pos.col - 1,
  })
end

--- Request signature help for the cursor position in `bufnr`.
function M.request(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  local clients = vim.lsp.get_clients({ bufnr = bufnr, method = "textDocument/signatureHelp" })
  if #clients == 0 then
    return hide()
  end
  generation = generation + 1
  local current = generation
  local client = clients[1]
  local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
  client:request("textDocument/signatureHelp", params, function(err, result)
    if current ~= generation or not vim.startswith(api.nvim_get_mode().mode, "i") then
      return
    end
    if err then
      return hide()
    end
    show(result)
  end, bufnr)
end

-- Whether `char` is one of a server's signature help trigger characters.
local function is_trigger(bufnr, char)
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr, method = "textDocument/signatureHelp" })) do
    local provider = client.server_capabilities.signatureHelpProvider or {}
    if
      vim.list_contains(provider.triggerCharacters or {}, char)
      or vim.list_contains(provider.retriggerCharacters or {}, char)
    then
      return true
    end
  end
  return false
end

---@param opts { keymap?: string|false }
function M.setup(opts)
  local timer = assert(vim.uv.new_timer())
  local function schedule(bufnr)
    timer:stop()
    timer:start(
      60,
      0,
      vim.schedule_wrap(function()
        if api.nvim_buf_is_valid(bufnr) and api.nvim_get_current_buf() == bufnr then
          M.request(bufnr)
        end
      end)
    )
  end
  local group = api.nvim_create_augroup("btmux_signature", {})
  -- Fires for every typed character, unlike TextChangedI, which waits for typeahead.
  api.nvim_create_autocmd("InsertCharPre", {
    group = group,
    callback = function(ev)
      if is_trigger(ev.buf, vim.v.char) then
        schedule(ev.buf)
      end
    end,
  })
  -- Keep an open signature up to date (TextChangedP: typing with the completion menu open).
  api.nvim_create_autocmd({ "TextChangedI", "TextChangedP", "CursorMovedI" }, {
    group = group,
    callback = function(ev)
      if shown then
        schedule(ev.buf)
      end
    end,
  })
  api.nvim_create_autocmd({ "InsertLeave", "BufLeave" }, {
    group = group,
    callback = function()
      timer:stop()
      hide()
    end,
  })
  if opts.keymap then
    vim.keymap.set("i", opts.keymap, function()
      M.request()
    end, { desc = "Signature help (btmux)" })
  end
end

return M
