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

## Blank pane until clicked

Sometimes a pane's shell goes invisible (the wallpaper shows through) until the
pane is clicked. Not reproducible on demand. Ruled out: the initial-replay cover
(it paints the theme background, not the wallpaper), the Neovim/VS Code
`opacity: 0` (a click doesn't close the surface), and stuck wterm painting
(pause and synchronized-output hold recover on their own).

Candidates:

- The emulator screen is empty: a local resize without a PTY size change clears
  the prompt, and nothing redraws it. A click can fix it by claiming size
  ownership (PTY resize, SIGWINCH) or sending a focus-in report.
- The rows exist but are scrolled away: wterm mounts scrollback rows around
  `scrollTop`, so a scroll change without a scroll event leaves only spacers in
  view.
- An ancestor hides the terminal with `opacity` or `visibility`.

Next time, before clicking, run this in devtools. `liveTextLen` 0 means an empty
screen, text with `inViewTextLen` 0 means scrolled away, and a non-empty
`hidden` means CSS:

```js
copy(
  JSON.stringify(
    [...document.querySelectorAll("[data-pane-id]")]
      .filter((p) => getComputedStyle(p).display !== "none")
      .map((p) => {
        const t = p.querySelector(".btm-wterm");
        if (!t) return { pane: p.dataset.paneId, noTerm: true };
        const b = t.getBoundingClientRect(),
          rows = [...t.querySelectorAll(".term-row")];
        const live = rows.filter(
          (r) => !r.classList.contains("term-scrollback-row"),
        );
        const inView = rows.filter((r) => {
          const x = r.getBoundingClientRect();
          return x.bottom > b.top && x.top < b.bottom;
        });
        const hidden = [];
        for (let e = t; e && e !== document.body; e = e.parentElement) {
          const s = getComputedStyle(e);
          if (s.visibility !== "visible" || +s.opacity < 1)
            hidden.push([e.className || e.tagName, s.visibility, s.opacity]);
        }
        return {
          pane: p.dataset.paneId,
          status: p.querySelector("[role=status]")?.textContent,
          cls: t.className,
          scrollTop: t.scrollTop,
          scrollHeight: t.scrollHeight,
          clientHeight: t.clientHeight,
          size: [b.width, b.height],
          rows: rows.length,
          liveRows: live.length,
          liveTextLen: live
            .map((r) => r.textContent)
            .join("")
            .trim().length,
          inViewRows: inView.length,
          inViewTextLen: inView
            .map((r) => r.textContent)
            .join("")
            .trim().length,
          hidden,
        };
      }),
    null,
    2,
  ),
);
```

Also note whether typing or a window switch fixes it, whether the pane was
active, other viewers of the session, what ran in the pane, and the action just
before. If that isn't enough, add a debug helper that also dumps wterm internals
(`_renderingPaused`, `_synchronizedOutputState`, `_pendingResizeScrollTop`) and
the pane's size ownership.
