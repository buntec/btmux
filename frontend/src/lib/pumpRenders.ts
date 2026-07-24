/**
 * ghostty-web only repaints on its own event-driven wake points (PTY writes,
 * cursor blink, etc.) — an idle terminal wouldn't otherwise animate a
 * u_time-driven post-process shader (a ramp, a glitch), so anything driving
 * one has to keep asking for frames itself. Runs a rAF loop calling
 * `requestRender()` on each renderer `getRenderers()` returns for
 * `durationMs`, then stops (calling `onDone` if given). Returns a cancel
 * function, usable directly as a useEffect cleanup.
 */
export function pumpRenders(
  getRenderers: () => Iterable<{ requestRender?(): void } | null | undefined>,
  durationMs: number,
  onDone?: () => void,
): () => void {
  let rafId = 0;
  const start = performance.now();
  const tick = () => {
    for (const renderer of getRenderers()) renderer?.requestRender?.();
    if (performance.now() - start < durationMs) {
      rafId = requestAnimationFrame(tick);
    } else {
      onDone?.();
    }
  };
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}
