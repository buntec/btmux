import { useEffect, useMemo, useRef, useState } from 'react';
import type { Terminal } from 'ghostty-web';
import { chromePalette, withAlpha } from '../lib/chrome-colors';
import { findMatches, snapshotRows, viewportYFor } from '../lib/terminalSearch';
import type { Theme } from '../state/types';

interface Props {
  term: Terminal;
  theme: Theme | null;
  termFont: number;
  onClose: () => void;
}

/**
 * Scrollback search for one pane (prefix + /). Enter jumps to the next older
 * match, Shift+Enter to a newer one. Searches a snapshot taken on open.
 */
export function PaneSearch({ term, theme, termFont, onClose }: Props) {
  const c = chromePalette(theme);
  const rows = useMemo(() => snapshotRows(term), [term]);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const matches = useMemo(() => findMatches(rows, query), [rows, query]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Start from the most recent match.
  useEffect(() => setCurrent(Math.max(0, matches.length - 1)), [matches]);

  useEffect(() => {
    const base = withAlpha(theme?.yellow ?? c.warn, 0.3);
    const active = withAlpha(theme?.yellow ?? c.warn, 0.75);
    term.setDecorations(matches.map((m, i) => ({ ...m, background: i === current ? active : base })));
    const match = matches[current];
    if (match) term.scrollToLine(viewportYFor(match.line, term.buffer.active.length, term.rows));
  }, [term, matches, current, theme, c.warn]);

  useEffect(
    () => () => {
      term.clearDecorations();
    },
    [term],
  );

  const step = (delta: number) => {
    if (matches.length > 0) setCurrent((i) => (i + delta + matches.length) % matches.length);
  };
  const close = () => {
    onClose();
    term.focus();
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: withAlpha(c.panelBg, 0.95),
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        boxShadow: `0 8px 30px ${withAlpha('#000000', 0.35)}`,
        color: c.fg,
        fontSize: Math.max(10, Math.round(termFont * 0.85)),
        zIndex: 5,
      }}
    >
      <input
        ref={inputRef}
        autoFocus
        aria-label="Search scrollback"
        placeholder="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
          else if (e.key === 'Enter') step(e.shiftKey ? 1 : -1);
        }}
        style={{ width: '16em', background: 'transparent', outline: 'none', color: c.fg }}
      />
      <span style={{ color: c.fgMuted, minWidth: '5em', textAlign: 'right' }}>
        {query ? (matches.length ? `${current + 1}/${matches.length}` : 'no match') : ''}
      </span>
      <button type="button" aria-label="Close search" onClick={close} style={{ color: c.fgMuted, cursor: 'pointer' }}>
        ×
      </button>
    </div>
  );
}
