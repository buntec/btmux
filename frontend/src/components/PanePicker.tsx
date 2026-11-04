import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { ClientMessage } from '../protocol/messages';
import type { PickRequest } from '../generated/protocol';
import type { PaneTerminal } from '../lib/paneTerminal';
import { filterPick, pickHaystack } from '../lib/pickFilter';
import { plainTextInput } from '../lib/touch';
import { stepIndex } from '../lib/utils';
import { useStore } from '../state/store';

/** Rows drawn; the count and a final row say when there are more. */
const MAX_ROWS = 200;

interface Props {
  id: string;
  term: PaneTerminal;
  /** The tab can see this pane. */
  shown: boolean;
  send: (msg: ClientMessage) => void;
}

/** `btmux pick`: a filterable menu at the pane's cursor. Keys reach it through `term.focus()`. */
export function PanePicker({ id, term, shown, send }: Props) {
  const [request, setRequest] = useState<PickRequest | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The unfiltered size, kept so that filtering never moves the input.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (shown) send({ type: 'pick_shown', id });
  }, [shown, id, send]);

  useEffect(() => {
    if (!shown || request) return;
    let canceled = false;
    fetch(`/api/picks/${id}`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<PickRequest>) : Promise.reject()))
      .then((loaded) => {
        if (!canceled) setRequest(loaded);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [shown, id, request]);

  useLayoutEffect(() => {
    term.setFocusTarget(inputRef.current);
    term.scrollToBottom();
    return () => term.setFocusTarget(null);
  }, [term]);

  const items = request?.items;
  const haystacks = useMemo(() => (items ?? []).map(pickHaystack), [items]);
  const { indices, total } = useMemo(
    () => filterPick(haystacks, size ? query : '', MAX_ROWS),
    [haystacks, query, size],
  );

  useLayoutEffect(() => {
    if (!shown || (!items && !failed) || size) return;
    const card = cardRef.current;
    if (card?.offsetParent) setSize({ width: card.offsetWidth, height: card.offsetHeight });
  }, [shown, items, failed, size]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const surface = card?.offsetParent;
    if (!card || !surface || !size) return;
    const place = () => {
      const bounds = surface.getBoundingClientRect();
      const anchor = term.cursorRect();
      const top = Math.max(0, Math.min(anchor.top - bounds.top, bounds.height));
      const bottom = Math.max(0, Math.min(anchor.bottom - bounds.top, bounds.height));
      const below = bounds.height - bottom;
      const above = size.height > below && top > below;
      const width = Math.min(size.width, bounds.width);
      card.style.width = `${width}px`;
      card.style.height = `${Math.min(size.height, above ? top : below)}px`;
      card.style.top = above ? '' : `${bottom}px`;
      card.style.bottom = above ? `${bounds.height - top}px` : '';
      card.style.left = `${Math.max(0, Math.min(anchor.left - bounds.left, bounds.width - width))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(surface);
    // Output can arrive after the menu: they come over different sockets.
    const offRender = term.onRender(place);
    return () => {
      observer.disconnect();
      offRender();
    };
  }, [term, size, shown]);

  useLayoutEffect(() => {
    scrollRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, indices]);

  const answer = (index: number | null) => {
    send({ type: 'pick_answer', id, index });
    // Other tabs close when the server's update arrives.
    const store = useStore.getState();
    store.setPicks(store.picks.filter((pick) => pick.id !== id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const step = (delta: number) => {
      e.preventDefault();
      setSelected((index) => stepIndex(index, delta, indices.length, true));
    };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (e.key === 'Tab' && !e.shiftKey)) step(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (e.key === 'Tab' && e.shiftKey)) step(-1);
    else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
      e.preventDefault();
      answer(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (indices.length) answer(indices[selected]);
    }
  };

  return (
    <Card
      ref={cardRef}
      padding={1}
      elevation="high"
      maxWidth="72ch"
      data-pane-picker=""
      className={`btm-mono absolute z-5 flex min-h-0 min-w-[24ch] flex-col gap-1 overflow-hidden ${size ? '' : 'opacity-0'}`}
    >
      <HStack gap={1} vAlign="center" className="shrink-0">
        <TextInput
          ref={(input) => {
            plainTextInput(input);
            inputRef.current = input;
          }}
          label={request?.prompt ?? 'Filter'}
          isLabelHidden
          size="sm"
          placeholder={request?.prompt ?? 'Filter'}
          autoComplete="off"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          containerClassName="min-w-0 flex-1"
        />
        <Text size="sm" color="secondary" textWrap="nowrap" className="tabular-nums">
          {total}/{items?.length ?? 0}
        </Text>
      </HStack>
      <VStack
        ref={scrollRef}
        className="max-h-80 min-h-0 flex-1 overflow-y-auto"
        onMouseDown={(e) => e.preventDefault()}
      >
        {failed ? (
          <Text size="sm" color="secondary">
            Couldn't load this list. Esc cancels.
          </Text>
        ) : (
          <List density="compact">
            {indices.map((index, row) => (
              <ListItem
                key={index}
                label={
                  // The label stays whole; the description gives way.
                  <HStack gap={3} hAlign="between" vAlign="center" className="min-w-0">
                    <Text type="code" maxLines={1} className="max-w-full shrink-0">
                      {items![index].label}
                    </Text>
                    {items![index].description && (
                      <Text type="code" size="sm" color="secondary" maxLines={1} className="min-w-0">
                        {items![index].description}
                      </Text>
                    )}
                  </HStack>
                }
                isSelected={row === selected}
                onClick={() => answer(index)}
              />
            ))}
          </List>
        )}
        {total > indices.length && (
          <Text size="sm" color="secondary">
            {total - indices.length} more; type to narrow
          </Text>
        )}
      </VStack>
    </Card>
  );
}
