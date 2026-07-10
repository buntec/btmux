/** Module-level rAF id so any new animation cancels the previous one. */
let rafId = 0;

/** Mutates the live SVG filter elements to set the pixelation block size. */
export function setPixBlock(b: number): void {
  const f = document.getElementById('btm-pix-flood');
  const c = document.getElementById('btm-pix-cell');
  const m = document.getElementById('btm-pix-morph');
  if (!f || !c || !m) return;
  const s = Math.max(1, b * 0.2);
  f.setAttribute('x', (b * 0.42).toFixed(2));
  f.setAttribute('y', (b * 0.42).toFixed(2));
  f.setAttribute('width', s.toFixed(2));
  f.setAttribute('height', s.toFixed(2));
  c.setAttribute('width', b.toFixed(2));
  c.setAttribute('height', b.toFixed(2));
  m.setAttribute('radius', (b * 0.5).toFixed(2));
}

/** Animates block size from `from` to `to` over `dur` ms (ease-out cubic). */
export function animatePix(from: number, to: number, dur: number, onDone?: () => void): void {
  cancelAnimationFrame(rafId);
  const t0 = performance.now();
  const easeOut = (x: number) => 1 - (1 - x) ** 3;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    setPixBlock(from + (to - from) * easeOut(p));
    if (p < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      onDone?.();
    }
  };
  rafId = requestAnimationFrame(step);
}
