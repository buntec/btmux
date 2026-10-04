import { useEffect, useId, useRef } from 'react';

// Animated app mark: the icon's thread bundle swayed like the aurora-curtain
// wallpaper (per-thread speed/frequency, center-weighted displacement,
// amber-to-teal gradient).
const THREADS = 7;
const SAMPLES = 36;
const X0 = 110;
const X1 = 914;
const AMPLITUDE = 150;
const PHASE_RATE = 0.9;
const MAX_FPS = 30;
const AMBER = [0.85, 0.55, 0.25] as const;
const TEAL = [0.2, 0.6, 0.65] as const;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function rgb(mixT: number, gain: number): string {
  const channel = (i: number) => Math.round(Math.min(1, (AMBER[i] + (TEAL[i] - AMBER[i]) * mixT) * gain) * 255);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

function threadY(i: number, u: number, phase: number): number {
  const frac = i / (THREADS - 1);
  const sy = (2 * u - 1) * 0.65;
  const env = smoothstep(1, 0, Math.abs(sy));
  const wave = Math.sin(phase * (0.6 + frac * 0.5) + sy * (4 + frac * 2) + 1.2);
  const drift = Math.sin(phase * 0.15 + i * 1.3) * 10;
  return 512 + (frac - 0.5) * 48 * (0.4 + env) + env * AMPLITUDE * wave + drift;
}

function threadPath(i: number, phase: number): string {
  let d = '';
  for (let k = 0; k <= SAMPLES; k++) {
    const u = k / SAMPLES;
    d += `${k ? 'L' : 'M'}${(X0 + u * (X1 - X0)).toFixed(1)},${threadY(i, u, phase).toFixed(1)}`;
  }
  return d;
}

const THREAD_STOPS = Array.from({ length: THREADS }, (_, i) => {
  const frac = i / (THREADS - 1);
  const gain = 0.75 + frac * 0.45;
  return [rgb(frac * 0.4, gain), rgb(0.4 + frac * 0.4, gain), rgb(0.6 + frac * 0.4, gain)];
});

export function AnimatedAppIcon({ animated, className }: { animated: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const threadsRef = useRef<(SVGPathElement | null)[]>([]);
  const glowRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const draw = (phase: number) => {
      threadsRef.current.forEach((path, i) => path?.setAttribute('d', threadPath(i, phase)));
      glowRef.current?.setAttribute('d', threadPath((THREADS - 1) / 2, phase));
    };
    draw(0);
    if (!animated || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    let phase = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / MAX_FPS - 1) return;
      phase += Math.min((now - last) / 1000, 0.1) * PHASE_RATE;
      last = now;
      draw(phase);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animated]);

  return (
    <svg viewBox="100 100 824 824" className={className} aria-hidden="true">
      <defs>
        <clipPath id={`${id}sq`}>
          <rect x="100" y="100" width="824" height="824" rx="185" />
        </clipPath>
        <filter id={`${id}soft`} x="100" y="100" width="824" height="824" filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="22" />
        </filter>
        <linearGradient id={`${id}fade`} x1="100" y1="0" x2="924" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.22" stopColor="#fff" />
          <stop offset="0.78" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}ends`}>
          <rect x="100" y="100" width="824" height="824" fill={`url(#${id}fade)`} />
        </mask>
        {THREAD_STOPS.map((stops, i) => (
          <linearGradient key={i} id={`${id}t${i}`} x1={X0} y1="0" x2={X1} y2="0" gradientUnits="userSpaceOnUse">
            {stops.map((color, s) => (
              <stop key={s} offset={s / (stops.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
        ))}
      </defs>
      <g clipPath={`url(#${id}sq)`} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          ref={glowRef}
          d={threadPath((THREADS - 1) / 2, 0)}
          stroke={`url(#${id}t${(THREADS - 1) / 2})`}
          strokeWidth="90"
          opacity="0.22"
          filter={`url(#${id}soft)`}
        />
        <g mask={`url(#${id}ends)`} strokeWidth="9" opacity="0.85">
          {THREAD_STOPS.map((_, i) => (
            <path
              key={i}
              ref={(el) => {
                threadsRef.current[i] = el;
              }}
              d={threadPath(i, 0)}
              stroke={`url(#${id}t${i})`}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
