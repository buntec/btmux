import { useLayoutEffect, useRef, type CSSProperties } from 'react';

/**
 * One-shot pane-switch border draw: a copy of the focus ring revealed by the
 * style's mask (see lib/paneSwitchBorder.ts). Publishes one vertical edge's
 * share of the perimeter as --btm-border-v so `trace` keeps a constant speed.
 * Remount to replay.
 */
export function PaneBorderDraw({
  className,
  color,
  edge,
  seconds,
}: {
  className: string;
  color: string;
  edge: string;
  seconds: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width + height > 0) el.style.setProperty('--btm-border-v', String(height / (2 * (width + height))));
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className={`btm-pane-border ${className}`}
      style={
        {
          '--btm-border-speed': `${seconds}s`,
          '--btm-border-color': color,
          '--btm-border-edge': edge,
        } as CSSProperties
      }
    />
  );
}
