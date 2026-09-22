if vim.g.loaded_btmux then
  return
end
vim.g.loaded_btmux = true

vim.api.nvim_create_user_command('BtmuxOpenFileBrowser', function(opts)
  require('btmux').open_file_browser(opts.args ~= '' and opts.args or nil, 'files')
end, { nargs = '?', complete = 'dir', desc = 'Open the btmux file browser' })

vim.api.nvim_create_user_command('BtmuxOpenGitBrowser', function(opts)
  require('btmux').open_file_browser(opts.args ~= '' and opts.args or nil, 'git')
end, { nargs = '?', complete = 'dir', desc = 'Open the btmux git browser' })
