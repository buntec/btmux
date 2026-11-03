import { Text } from '@astryxdesign/core/Text';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { getAnimations } from '../state/configDefaults';
import { useStore } from '../state/store';

// The app mark: threads sharing a traveling wave, pinched at its nodes and
// fanned at its peaks. Replaces Astryx's ring.
const SIZES = {
  sm: { box: 'size-3.5', threads: 3, stroke: 0.9 },
  md: { box: 'size-5', threads: 3, stroke: 1 },
  lg: { box: 'size-6', threads: 4, stroke: 1 },
  xl: { box: 'size-9', threads: 5, stroke: 1.25 },
};

const SAMPLES = 20;
const X0 = 8;
const X1 = 92;
const RATE = 4;
const REDUCED_RATE = 1;
const REST_PHASE = 1.2;
const MAX_FPS = 30;

function threadPath(i: number, threads: number, phase: number): string {
  const frac = i / (threads - 1);
  let d = '';
  for (let k = 0; k <= SAMPLES; k++) {
    const u = k / SAMPLES;
    const sy = 2 * u - 1;
    const env = 1 - sy ** 4;
    const y = 50 + (frac - 0.5) * 6 + env * (6 + frac * 38) * Math.sin(sy * 3.8 - phase + frac * 0.3);
    d += `${k ? 'L' : 'M'}${(X0 + u * (X1 - X0)).toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

// One clock for every spinner, so they stay in phase and share a frame.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const listeners = new Set<(phase: number) => void>();
let raf = 0;
let phase = REST_PHASE;
let last = 0;

function tick(now: number) {
  raf = requestAnimationFrame(tick);
  if (now - last < 1000 / MAX_FPS - 1) return;
  phase += (Math.min(now - last, 100) / 1000) * (reducedMotion.matches ? REDUCED_RATE : RATE);
  last = now;
  for (const listener of listeners) listener(phase);
}

function subscribe(listener: (phase: number) => void) {
  listeners.add(listener);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
}

export function Spinner({
  size = 'md',
  label,
  'aria-label': ariaLabel,
}: {
  size?: keyof typeof SIZES;
  label?: ReactNode;
  'aria-label'?: string;
}) {
  const { box, threads, stroke } = SIZES[size];
  const animated = useStore((state) => getAnimations(state.config));
  const pathsRef = useRef<(SVGPathElement | null)[]>([]);
  const labelId = useId();

  useEffect(() => {
    const draw = (phase: number) =>
      pathsRef.current.forEach((path, i) => path?.setAttribute('d', threadPath(i, threads, phase)));
    draw(phase);
    return animated ? subscribe(draw) : undefined;
  }, [animated, threads]);

  const hasLabel = label != null;
  const namedByLabel = hasLabel && typeof label === 'string' && ariaLabel == null;
  const wave = (
    <svg
      viewBox="0 0 100 100"
      role="status"
      aria-label={namedByLabel ? undefined : (ariaLabel ?? 'Loading')}
      aria-labelledby={namedByLabel ? labelId : undefined}
      className={`${box} inline-block shrink-0 rotate-30 align-middle text-accent`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={stroke}
    >
      {Array.from({ length: threads }, (_, i) => (
        <path
          key={i}
          ref={(el) => {
            pathsRef.current[i] = el;
          }}
          d={threadPath(i, threads, REST_PHASE)}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
  if (!hasLabel) return wave;
  return (
    <span className="inline-flex flex-col items-center gap-2">
      {wave}
      {typeof label === 'string' ? (
        <Text id={labelId} type="body" weight="bold">
          {label}
        </Text>
      ) : (
        label
      )}
    </span>
  );
}
