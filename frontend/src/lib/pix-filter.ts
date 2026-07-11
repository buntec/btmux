/** Pixelation block size at rest (filter off / ramp start-and-end point). */
export const PIX_MIN_BLOCK = 1;
/** Pixelation block size at full effect (ramp target while overlay is open). */
export const PIX_MAX_BLOCK = 8;
/** Ramp-in duration (ms) when the effect turns on. */
export const PIX_RAMP_IN_MS = 250;
/** Ramp-out duration (ms) when the effect turns off. */
export const PIX_RAMP_OUT_MS = 150;
/** CSS brightness() multiplier applied alongside the filter while pixelated. */
export const PIX_BRIGHTNESS = 0.8;

/** feFlood x/y offset as a fraction of block size (positions the sampled dot within a cell). */
const FLOOD_OFFSET_RATIO = 0.1;
/** feFlood width/height as a fraction of block size (size of the sampled dot). */
const FLOOD_SIZE_RATIO = 0.5;
/** feMorphology dilate radius as a fraction of block size (grows the dot to fill the cell). */
const MORPH_RADIUS_RATIO = 0.8;

/** Module-level rAF id so any new animation cancels the previous one. */
let rafId = 0;

/** Mutates the live SVG filter elements to set the pixelation block size. */
export function setPixBlock(b: number): void {
  const f = document.getElementById('btm-pix-flood');
  const c = document.getElementById('btm-pix-cell');
  const m = document.getElementById('btm-pix-morph');
  if (!f || !c || !m) return;
  const s = Math.max(1, b * FLOOD_SIZE_RATIO);
  f.setAttribute('x', (b * FLOOD_OFFSET_RATIO).toFixed(2));
  f.setAttribute('y', (b * FLOOD_OFFSET_RATIO).toFixed(2));
  f.setAttribute('width', s.toFixed(2));
  f.setAttribute('height', s.toFixed(2));
  c.setAttribute('width', b.toFixed(2));
  c.setAttribute('height', b.toFixed(2));
  m.setAttribute('radius', (b * MORPH_RADIUS_RATIO).toFixed(2));
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
