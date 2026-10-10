-- Runs after your config, so an explicit `require("btmux").setup({...})` there wins.
if vim.g.btmux then
  require("btmux").setup()
end
