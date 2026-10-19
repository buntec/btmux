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

In @astryxdesign/core 0.6.5 (still in 0.7.1), a collapsed childless
`SideNavItem` renders `<Tooltip anchorRef={itemRef}>` inside the `<div
ref={itemRef}>` it anchors to. React runs the child's layout effect before it
attaches the parent's ref, so `anchorRef.current` is null, and the effect's
stable deps never rerun it: the rail tooltip never shows. `IconButton` is
unaffected (`useTooltip` via a callback ref). `RailNavItem`
(`frontend/src/components/RailNavItem.tsx`) works around it by wrapping the item
in a children-mode `Tooltip`, enabled only while the rail is collapsed. The
sidebar's own "Expand sidebar" toggle still has no tooltip.

Options:

- Report it upstream with a repro: hover a collapsed `SideNavItem`; the item
  never gets `aria-describedby`.
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
