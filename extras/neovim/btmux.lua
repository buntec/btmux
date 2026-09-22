-- Open the btmux file browser (prefix + f / prefix + g) from Neovim, at a
-- given directory, in whichever btmux pane you're editing from.
--
-- Paste this into your init.lua, then bind whichever modes you want:
--   vim.keymap.set('n', '<leader>-', function() btmux_open_file_browser() end)
--   vim.keymap.set('n', '<leader>g-', function() btmux_open_file_browser(nil, 'git') end)
--
-- Requires Neovim running inside a btmux pane, which sets BTMUX_PANE_ID,
-- BTMUX_API_URL, and BTMUX_AUTH_TOKEN in its environment.

--- Open the btmux file browser at `dir` (default: current buffer's directory).
--- `mode` is 'files' (default) or 'git'.
function btmux_open_file_browser(dir, mode)
  local pane_id = vim.env.BTMUX_PANE_ID
  local api_url = vim.env.BTMUX_API_URL
  local token = vim.env.BTMUX_AUTH_TOKEN
  if not (pane_id and api_url and token) then
    vim.notify('btmux: not running inside a btmux pane', vim.log.levels.WARN)
    return
  end

  dir = dir or vim.fn.expand('%:p:h')
  local body = vim.json.encode({ path = dir, mode = mode or 'files' })

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

vim.keymap.set('n', '<leader>-', function()
  btmux_open_file_browser()
end, { desc = 'btmux: open file browser here' })

vim.keymap.set('n', '<leader>g-', function()
  btmux_open_file_browser(nil, 'git')
end, { desc = 'btmux: open git view here' })
