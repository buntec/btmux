import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { WidgetRequest } from '../generated/protocol';
import { isCancelKey, usePaneWidget, type PaneWidgetProps } from '../hooks/usePaneWidget';
import { filterPick, pickHaystack } from '../lib/pickFilter';
import { plainTextInput } from '../lib/touch';
import { stepIndex } from '../lib/utils';

/** Rows drawn; the count and a final row say when there are more. */
const MAX_ROWS = 200;

type PickRequest = Extract<WidgetRequest, { type: 'pick' }>;

/** `btmux pick`: a filterable menu at the pane's cursor. Keys reach it through `term.focus()`. */
export function PanePicker(props: PaneWidgetProps) {
  const { term } = props;
  const { request, failed, measured, answer, cardProps } = usePaneWidget<PickRequest>(props);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    term.setFocusTarget(inputRef.current);
  }, [term]);

  const items = request?.items;
  const haystacks = useMemo(() => (items ?? []).map(pickHaystack), [items]);
  const { indices, total } = useMemo(
    () => filterPick(haystacks, measured ? query : '', MAX_ROWS),
    [haystacks, query, measured],
  );

  useLayoutEffect(() => {
    scrollRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, indices]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const step = (delta: number) => {
      e.preventDefault();
      setSelected((index) => stepIndex(index, delta, indices.length, true));
    };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (e.key === 'Tab' && !e.shiftKey)) step(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (e.key === 'Tab' && e.shiftKey)) step(-1);
    else if (isCancelKey(e)) {
      e.preventDefault();
      answer(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (indices.length) answer({ type: 'pick', index: indices[selected] });
    }
  };

  return (
    <Card {...cardProps} maxWidth="72ch">
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
                onClick={() => answer({ type: 'pick', index })}
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
