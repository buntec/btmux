import { useEffect, useState } from 'react';
import type { SearchState } from '@wterm/dom';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Card } from '@astryxdesign/core/Card';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { chromePalette, withAlpha } from '../lib/chrome-colors';
import { plainTextInput } from '../lib/touch';
import type { PaneTerminal } from '../lib/paneTerminal';
import type { Theme } from '../state/types';

const MAX_SEARCH_LENGTH = 1024;

interface Props {
  term: PaneTerminal;
  theme: Theme | null;
  onClose: () => void;
}

/**
 * Scrollback search for one pane (prefix + /). Enter or the up button jumps to
 * the next older match, Shift+Enter or the down button to a newer one.
 */
export function PaneSearch({ term, theme, onClose }: Props) {
  const c = chromePalette(theme);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState | null>(null);

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
    <Card padding={1} elevation="high" className="absolute top-2 right-2 z-5 max-w-[calc(100%-1rem)]">
      <HStack gap={1} vAlign="center">
        <TextInput
          ref={plainTextInput}
          label="Search scrollback"
          isLabelHidden
          size="sm"
          placeholder="Search"
          hasAutoFocus
          autoComplete="off"
          value={query}
          onChange={(value) => setQuery(value.slice(0, MAX_SEARCH_LENGTH))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') close();
            else if (e.key === 'Enter') step(e.shiftKey ? 1 : -1);
          }}
          containerClassName="w-48 min-w-0 shrink"
        />
        <Text size="sm" color="secondary" textWrap="nowrap" className="min-w-[4.5em] text-end tabular-nums">
          {query && state ? (state.count ? `${state.activeIndex + 1}/${state.count}` : 'no match') : ''}
        </Text>
        <IconButton label="Older match" icon={<ChevronUp />} variant="ghost" size="sm" onClick={() => step(-1)} />
        <IconButton label="Newer match" icon={<ChevronDown />} variant="ghost" size="sm" onClick={() => step(1)} />
        <IconButton label="Close search" icon={<X />} variant="ghost" size="sm" onClick={close} />
      </HStack>
    </Card>
  );
}
