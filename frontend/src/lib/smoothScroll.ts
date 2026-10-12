interface ScrollAnim {
  target: number;
  stop: () => void;
}

const anims = new WeakMap<HTMLElement, ScrollAnim>();

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Scroll `el` by `dy` px with an ease-out over `duration` ms; repeated calls extend the target. */
export function smoothScrollBy(el: HTMLElement, dy: number, duration: number) {
  const prev = anims.get(el);
  prev?.stop();
  const max = el.scrollHeight - el.clientHeight;
  const target = Math.max(0, Math.min(max, (prev?.target ?? el.scrollTop) + dy));
  if (duration <= 0) {
    el.scrollTop = target;
    return;
  }

  const from = el.scrollTop;
  const start = performance.now();
  let frame = 0;
  // The user's own scrolling cancels the animation.
  const stop = () => {
    cancelAnimationFrame(frame);
    if (anims.get(el) === anim) anims.delete(el);
    el.removeEventListener('wheel', stop);
    el.removeEventListener('pointerdown', stop);
  };
  const anim: ScrollAnim = { target, stop };
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    el.scrollTop = from + (target - from) * easeOutCubic(t);
    if (t < 1) frame = requestAnimationFrame(step);
    else stop();
  };
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('pointerdown', stop);
  frame = requestAnimationFrame(step);
  anims.set(el, anim);
}
