import { useEffect, useRef, useState } from 'react';
import type { SearchState } from '@wterm/dom';
import { chromePalette, withAlpha } from '../lib/chrome-colors';
import type { PaneTerminal } from '../lib/paneTerminal';
import type { Theme } from '../state/types';

const MAX_SEARCH_LENGTH = 1024;

interface Props {
  term: PaneTerminal;
  theme: Theme | null;
  termFont: number;
  onClose: () => void;
}

/**
 * Scrollback search for one pane (prefix + /). Enter jumps to the next older
 * match, Shift+Enter to a newer one.
 */
export function PaneSearch({ term, theme, termFont, onClose }: Props) {
  const c = chromePalette(theme);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    term.onSearchChange(setState);
    return () => {
      term.onSearchChange(null);
      term.search('');
    };
  }, [term]);

  useEffect(() => {
    const yellow = theme?.yellow ?? c.warn;
    term.element.style.setProperty('--term-search-match', withAlpha(yellow, 0.3));
    term.element.style.setProperty('--term-search-active', withAlpha(yellow, 0.75));
    term.element.style.setProperty('--term-search-border', yellow);
  }, [term, theme, c.warn]);

  useEffect(() => term.search(query), [term, query]);

  const step = (delta: number) => {
    if (delta < 0) term.findPrevious();
    else term.findNext();
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
        maxLength={MAX_SEARCH_LENGTH}
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
        {query && state ? (state.count ? `${state.activeIndex + 1}/${state.count}` : 'no match') : ''}
      </span>
      <button type="button" aria-label="Close search" onClick={close} style={{ color: c.fgMuted, cursor: 'pointer' }}>
        ×
      </button>
    </div>
  );
}
