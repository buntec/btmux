# TODO

## wterm cell measurement under CSS transforms

wterm 0.5.4 measures cells with `getBoundingClientRect` (`_measureCharSize`,
`_setRowHeight`), which includes ancestor transforms. Window-grid thumbnails
(`MirrorPane`) shrink with `transform: scale()`, so wterm measures scaled cells.
`unscaleMeasurement` in `frontend/src/lib/paneTerminal.ts` works around this by
replacing those two private methods; recheck it on every `@wterm/*` bump.

Reported upstream: https://github.com/vercel-labs/wterm/issues/246.

Options:

- Send a fix as an upstream PR from a fork, in
  `packages/@wterm/dom/src/wterm.ts`, with a Playwright test like their
  `e2e/harness/tests/cell-width.spec.ts`.
- Or scale thumbnails by font size and row height instead of a transform, and
  drop the patch. Cell widths at tiny font sizes aren't exactly proportional, so
  check the fit visually.

Once fixed upstream, remove `unscaleMeasurement` and bump `@wterm/*`.

## Astryx collapsed SideNavItem tooltips

In @astryxdesign/core 0.6.5 (still in 0.7.2-canary), a collapsed childless
`SideNavItem` renders `<Tooltip anchorRef={itemRef}>` inside the `<div
ref={itemRef}>` it anchors to. React runs the child's layout effect before it
attaches the parent's ref, so `anchorRef.current` is null, and the effect's
stable deps never rerun it: the rail tooltip never shows. `IconButton` is
unaffected (`useTooltip` via a callback ref). `RailNavItem`
(`frontend/src/components/RailNavItem.tsx`) works around it by wrapping the item
in a children-mode `Tooltip`, enabled only while the rail is collapsed. The
sidebar's own "Expand sidebar" toggle still has no tooltip.

Only items that mount collapsed are affected; collapsing later works.

Reported upstream: https://github.com/facebook/astryx/issues/7692.

Options:

- Fix upstream by tracking the anchor in state (callback ref) instead of reading
  `anchorRef.current` in the effect, and add a test that mounts collapsed.

Once fixed upstream, replace `RailNavItem` with `SideNavItem` and bump Astryx.

## wterm textarea position after clear

wterm 0.5.4 moves its input textarea to the cursor only on focus and while
composing (`syncInputPosition`). Its absolute offset is in scroll-content
coordinates, so after focusing with deep scrollback, `clear` (`ESC[3J`) leaves
it far below the rows: it keeps the scroll height, and `_doRender` scrolls to
the bottom, showing an empty pane until the next focus. `trackInputPosition`
in `frontend/src/lib/paneTerminal.ts` repositions it after every render;
`terminal-browser-test.ts` covers it. Recheck it on every `@wterm/*` bump.

Reported upstream: https://github.com/vercel-labs/wterm/issues/245.

Options:

- Fix upstream by positioning the textarea in `syncInputPosition` always, or
  before `_scrollToBottom` reads `scrollHeight`.

Once fixed upstream, remove `trackInputPosition` and bump `@wterm/*`.

## Approve or deny agent permission requests from notifications

A `PermissionRequest` hook already marks the pane as needing attention. Add
Approve and Deny buttons to its toast (and the agent grid) that answer the
active prompt by sending its keys to the pane, so you don't have to switch to
it. Only act while the request is still pending, and check that the keys match
the prompt the agent shows.

## Encrypt the upgrade handoff file

`handoff.rs` writes session snapshots and replay journals (pane output, which
can contain secrets) to an unlinked, owner-only file. Seal it (e.g. AES-256-GCM)
with a random key that never touches disk, passed to the new image through an
inherited pipe. Bump `handoff::VERSION`.

## Fork an agent conversation into a new pane

Hooks already report the agent's `session_id`. Add an action (key, command
palette, agent grid, REST/MCP) that splits the pane and starts the same agent
with its fork-session option (e.g. `claude --resume <id> --fork-session`) in
the pane's cwd.

## Notify when a long command finishes

Notify when a command that ran for at least N seconds (configurable, e.g. 15)
finishes in a pane you aren't looking at, with its exit status. Needs shell
integration (OSC 133 prompt and command marks) for zsh, bash, and fish to know
where commands start and end. The same marks would let `run_command` wait for
the prompt instead of 400 ms of quiet output.

## Neovim clipboard in remote browsers

The built-in Neovim uses the server host's clipboard provider, so `"+` (and the
plugin's `<D-c>`/`<D-x>`) never reach a browser on another machine. Neovide
bridges this for `--server` sessions with a `g:clipboard` that calls back to
the GUI. A btmux version:

- The plugin sets `g:clipboard` to `rpcrequest` the browser tab that last had
  focus (tabs report their channel on focus), falling back to the server
  provider when none is known or it fails.
- `NvimSurface.tsx` answers those requests (it currently rejects all UI
  requests) with `navigator.clipboard`.
- The async clipboard API only exists on secure origins (HTTPS or localhost),
  and reading asks for permission in Chromium; plain-HTTP remotes keep the
  server provider.
