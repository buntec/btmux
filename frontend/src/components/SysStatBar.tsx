import { useSysStats } from '../hooks/useSysStats';
import type { ChromePalette } from '../lib/chrome-colors';
import { mix, withAlpha } from '../lib/chrome-colors';

interface Props {
  c: ChromePalette;
  barH: number;
  font: number;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}M`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}K`;
  return `${bytes}B`;
}

function fmtMemPct(used: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((used / total) * 100)}%`;
}

function CpuBars({ cpu, c, barH }: { cpu: number[]; c: ChromePalette; barH: number }) {
  const innerH = Math.round(barH * 0.55);
  const barW = Math.max(2, Math.round(barH * 0.13));
  const gap = Math.max(1, Math.round(barW * 0.4));

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: `${gap}px`,
        height: `${innerH}px`,
      }}
    >
      {cpu.map((pct, i) => {
        // Color: green → yellow → red based on load
        const t = Math.min(1, pct / 100);
        const color = t < 0.6
          ? mix(c.accent, c.warn, t / 0.6)
          : mix(c.warn, '#ff5f5f', (t - 0.6) / 0.4);
        const h = Math.max(1, Math.round(innerH * Math.max(0.04, t)));
        return (
          <div
            key={i}
            title={`CPU ${i}: ${pct.toFixed(0)}%`}
            style={{
              width: `${barW}px`,
              height: `${h}px`,
              background: color,
              borderRadius: '1px',
              opacity: 0.9,
              flexShrink: 0,
            }}
          />
        );
      })}
    </div>
  );
}

export function SysStatBar({ c, barH, font }: Props) {
  const stats = useSysStats();

  if (!stats) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          padding: '0 13px',
          color: c.fgDim,
          borderLeft: `1px solid ${c.borderDim}`,
          fontSize: `${font}px`,
        }}
      >
        —
      </div>
    );
  }

  const memPct = stats.mem_total ? stats.mem_used / stats.mem_total : 0;
  const memColor = memPct > 0.85 ? '#ff5f5f' : memPct > 0.65 ? c.warn : c.accent;
  const memBarW = Math.round(barH * 0.9);
  const memFillW = Math.round(memBarW * memPct);
  const innerH = Math.round(barH * 0.55);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        height: '100%',
        padding: '0 13px',
        borderLeft: `1px solid ${c.borderDim}`,
        fontSize: `${font}px`,
      }}
    >
      {/* CPU bar chart */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span style={{ color: c.fgDim, fontSize: `${Math.max(8, font - 1)}px`, letterSpacing: '.03em' }}>CPU</span>
        <CpuBars cpu={stats.cpu} c={c} barH={barH} />
      </div>

      {/* Memory bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span style={{ color: c.fgDim, fontSize: `${Math.max(8, font - 1)}px`, letterSpacing: '.03em' }}>MEM</span>
        <div
          title={`${fmtBytes(stats.mem_used)} / ${fmtBytes(stats.mem_total)}`}
          style={{
            position: 'relative',
            width: `${memBarW}px`,
            height: `${Math.round(innerH * 0.55)}px`,
            background: withAlpha(c.fgDim, 0.2),
            borderRadius: '2px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${memFillW}px`,
              background: memColor,
              borderRadius: '2px',
              opacity: 0.85,
            }}
          />
        </div>
        <span style={{ color: c.fgMuted, minWidth: '4ch', textAlign: 'right' }}>
          {fmtMemPct(stats.mem_used, stats.mem_total)}
        </span>
      </div>

      {/* Network */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: c.fgDim }}>
        <span style={{ fontSize: `${Math.max(8, font - 1)}px`, letterSpacing: '.03em' }}>NET</span>
        <span style={{ color: c.accent, fontSize: `${Math.max(8, font - 1)}px` }}>↓</span>
        <span style={{ color: c.fgMuted, minWidth: '4ch', textAlign: 'right' }}>{fmtBytes(stats.net_rx)}</span>
        <span style={{ color: c.warn, fontSize: `${Math.max(8, font - 1)}px`, marginLeft: '2px' }}>↑</span>
        <span style={{ color: c.fgMuted, minWidth: '4ch', textAlign: 'right' }}>{fmtBytes(stats.net_tx)}</span>
      </div>
    </div>
  );
}
