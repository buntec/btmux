local health = require("btmux.health")

local function messages()
  return vim.tbl_map(function(f)
    return (f.warn and "warn: " or "info: ") .. f.msg
  end, health.findings())
end
local function has(pattern)
  for _, msg in ipairs(messages()) do
    if msg:find(pattern) then
      return true
    end
  end
  return false
end

assert(not has("noice") and not has("vim.notify") and not has("'mouse'"), vim.inspect(messages()))

local notify = vim.notify
vim.notify = function() end
assert(has("^warn: `vim.notify` is replaced"))
package.loaded.noice = {}
assert(has("^warn: noice") and not has("vim.notify"))
package.loaded.noice = nil
vim.notify = notify

vim.o.mouse = ""
assert(has("^warn: 'mouse' is empty"))
vim.o.mouse = "a"

package.loaded.fidget = {}
assert(has("^warn: fidget"))
require("btmux").config = vim.tbl_extend("force", require("btmux").defaults, { progress = false })
assert(not has("fidget"))

package.loaded["blink.cmp"] = {}
package.loaded["blink.cmp.config"] = { signature = { enabled = true } }
assert(has("^info: blink.cmp draws") and has("^warn: blink.cmp's signature"))

package.loaded["snacks.scroll"] = { enabled = true }
assert(has("^warn: snacks.nvim's scroll"))

print("ok")
