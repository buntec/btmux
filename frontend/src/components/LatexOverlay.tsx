import { chromePalette, withAlpha } from '../lib/chrome-colors';
import type { PaneLatexMatch } from '../lib/latexScan';
import type { Theme } from '../state/types';

interface Props {
  theme: Theme | null;
  termFont: number;
  matches: PaneLatexMatch[];
  /** Highlight a formula's source cells in the terminal (null clears). */
  onHover: (match: PaneLatexMatch | null) => void;
  onClose: () => void;
}

/** Side panel listing the on-screen formulas of one pane, rendered by KaTeX. */
export function LatexOverlay({ theme, termFont, matches, onHover, onClose }: Props) {
  const c = chromePalette(theme);
  return (
    <div
      // Keep keyboard focus in the terminal.
      onMouseDown={(e) => e.preventDefault()}
      onMouseLeave={() => onHover(null)}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        bottom: 8,
        width: 'min(460px, 48%)',
        display: 'flex',
        flexDirection: 'column',
        background: withAlpha(c.panelBg, 0.95),
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        boxShadow: `0 8px 30px ${withAlpha('#000000', 0.35)}`,
        color: c.fg,
        zIndex: 5,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: `1px solid ${c.borderDim}`,
          fontSize: Math.max(10, Math.round(termFont * 0.75)),
          color: c.fgMuted,
          flex: 'none',
        }}
      >
        <span style={{ color: c.accent, fontWeight: 800 }}>∑</span>
        <span>LaTeX · {matches.length}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Close LaTeX overlay"
          onClick={onClose}
          style={{ color: c.fgMuted, cursor: 'pointer', lineHeight: 1 }}
        >
          ×
        </button>
      </div>
      <div style={{ overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {matches.length === 0 && (
          <div style={{ color: c.fgDim, fontSize: termFont * 0.8, padding: 6 }}>No LaTeX on screen.</div>
        )}
        {matches.map((m, i) => (
          <div
            key={i}
            title={m.tex}
            onMouseEnter={() => onHover(m)}
            style={{
              padding: m.display ? '10px 12px' : '6px 12px',
              borderRadius: 6,
              border: `1px solid ${c.borderDim}`,
              background: withAlpha(c.bodyBg, 0.6),
              fontSize: Math.round(termFont * 1.1),
              overflowX: 'auto',
              overflowY: 'hidden',
            }}
            // KaTeX output, rendered with trust: false.
            dangerouslySetInnerHTML={{ __html: m.html }}
          />
        ))}
      </div>
    </div>
  );
}
