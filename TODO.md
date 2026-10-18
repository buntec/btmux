# TODO

## wterm cell measurement under CSS transforms

wterm 0.5.4 measures cells with `getBoundingClientRect` (`_measureCharSize`,
`_setRowHeight`), which includes ancestor transforms. Window-grid thumbnails
(`MirrorPane`) shrink with `transform: scale()`, so wterm measures scaled cells.
`unscaleMeasurement` in `frontend/src/lib/paneTerminal.ts` works around this by
replacing those two private methods; recheck it on every `@wterm/*` bump.

Options:

- Report it upstream (vercel-labs/wterm; no existing issue) with a repro and the
  fix: divide by the element's scale, as `unscaleMeasurement` does.
- Also send a fix as an upstream PR from a fork, in
  `packages/@wterm/dom/src/wterm.ts`, with a Playwright test like their
  `e2e/harness/tests/cell-width.spec.ts`.
- Or scale thumbnails by font size and row height instead of a transform, and
  drop the patch. Cell widths at tiny font sizes aren't exactly proportional, so
  check the fit visually.

Once fixed upstream, remove `unscaleMeasurement` and bump `@wterm/*`.
