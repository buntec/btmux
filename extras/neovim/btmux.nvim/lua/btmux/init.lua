-- Talk to btmux's REST API from Neovim, when Neovim is running inside a
-- btmux pane (which sets BTMUX_PANE_ID, BTMUX_API_URL, and BTMUX_AUTH_TOKEN
-- in its environment).

local M = {}

M.config = {
  -- Set an entry to false to skip creating that keymap.
  keymaps = {
    open_file_browser = '<leader>-',
    open_git_browser = '<leader>g-',
  },
}

--- Open the btmux file browser at `dir` (default: current buffer's directory).
--- `mode` is 'files' (default) or 'git'.
function M.open_file_browser(dir, mode)
  local pane_id = vim.env.BTMUX_PANE_ID
  local api_url = vim.env.BTMUX_API_URL
  local token = vim.env.BTMUX_AUTH_TOKEN
  if not (pane_id and api_url and token) then
    vim.notify('btmux: not running inside a btmux pane', vim.log.levels.WARN)
    return
  end

  -- Neovim always has a default RPC server; start one if this build somehow
  -- doesn't (v:servername empty), so files picked in the browser come back here.
  local editor_addr = vim.v.servername
  if not editor_addr or editor_addr == '' then
    editor_addr = vim.fn.serverstart()
  end

  local buffer_path = vim.bo.buftype == '' and vim.fn.expand('%:p') or ''
  local focus_file = nil
  if not dir and buffer_path ~= '' then
    dir = vim.fn.fnamemodify(buffer_path, ':h')
    focus_file = vim.fn.fnamemodify(buffer_path, ':t')
  end
  dir = dir or vim.fn.getcwd()
  local body = vim.json.encode({ path = dir, mode = mode or 'files', editor_addr = editor_addr, focus_file = focus_file })

  vim.system({
    'curl',
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-X',
    'POST',
    api_url .. '/api/panes/' .. pane_id .. '/open-file-browser',
    '-H',
    'Authorization: Bearer ' .. token,
    '-H',
    'Content-Type: application/json',
    '-d',
    body,
  }, { text = true }, function(res)
    if res.code ~= 0 or vim.trim(res.stdout or '') ~= '204' then
      vim.schedule(function()
        vim.notify('btmux: failed to open file browser (' .. (res.stdout or res.code) .. ')', vim.log.levels.ERROR)
      end)
    end
  end)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})

  local keymaps = M.config.keymaps or {}
  if keymaps.open_file_browser then
    vim.keymap.set('n', keymaps.open_file_browser, function()
      M.open_file_browser()
    end, { desc = 'btmux: open file browser here' })
  end
  if keymaps.open_git_browser then
    vim.keymap.set('n', keymaps.open_git_browser, function()
      M.open_file_browser(nil, 'git')
    end, { desc = 'btmux: open git view here' })
  end
end

return M
