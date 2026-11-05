import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { WidgetRequest } from '../generated/protocol';
import { isCancelKey, usePaneWidget, type PaneWidgetProps } from '../hooks/usePaneWidget';
import { KeyHint } from './KeyHint';
import { usePressHint } from '../hooks/usePressHint';
import { filterPick, pickHaystack, pickLabel } from '../lib/pickFilter';
import { plainTextInput } from '../lib/touch';
import { stepIndex } from '../lib/utils';

/** Rows drawn; the count and a final row say when there are more. */
const MAX_ROWS = 200;

type PickRequest = Extract<WidgetRequest, { type: 'pick' }>;

/** `btmux pick`: a filterable menu at the pane's cursor. Keys reach it through `term.focus()`. */
export function PanePicker(props: PaneWidgetProps) {
  const { term } = props;
  const { request, failed, measured, answer, cardRef, cardProps } = usePaneWidget<PickRequest>(props);
  // Until the user types, the request's query, which arrives after the widget.
  const [edited, setEdited] = useState<string | null>(null);
  const query = edited ?? request?.query ?? '';
  const [selected, setSelected] = useState(0);
  const [marked, setMarked] = useState<ReadonlySet<number>>(new Set());
  const multi = request?.multi ?? false;
  const pressHint = usePressHint(cardRef);
  const scrollRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    term.setFocusTarget(inputRef.current);
  }, [term]);

  const items = request?.items;
  const haystacks = useMemo(() => (items ?? []).map(pickHaystack), [items]);
  const noSort = request?.no_sort;
  const { indices, total } = useMemo(
    () => filterPick(haystacks, measured ? query : '', MAX_ROWS, noSort),
    [haystacks, query, measured, noSort],
  );

  useLayoutEffect(() => {
    scrollRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, indices]);

  const toggleMark = (index: number) => {
    setMarked((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const step = (delta: number) => {
      e.preventDefault();
      setSelected((index) => stepIndex(index, delta, indices.length, true));
    };
    if (multi && e.key === 'Tab') {
      if (indices.length) toggleMark(indices[selected]);
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (e.key === 'Tab' && !e.shiftKey)) step(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (e.key === 'Tab' && e.shiftKey)) step(-1);
    else if (isCancelKey(e)) {
      e.preventDefault();
      answer(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (marked.size) answer({ type: 'pick', indices: [...marked] });
      else if (indices.length) answer({ type: 'pick', indices: [indices[selected]] });
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
            setEdited(value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          containerClassName="min-w-0 flex-1"
        />
        <Text size="sm" color="secondary" textWrap="nowrap" className="tabular-nums">
          {marked.size > 0 && `${marked.size} marked · `}
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
                startContent={
                  multi && (
                    <Text type="code" className={marked.has(index) ? '' : 'invisible'}>
                      ✓
                    </Text>
                  )
                }
                label={
                  // The label stays whole; the description gives way.
                  <HStack gap={3} hAlign="between" vAlign="center" className="min-w-0">
                    <Text type="code" maxLines={1} className="max-w-full shrink-0">
                      {pickLabel(items![index].label)}
                    </Text>
                    {items![index].description && (
                      <Text type="code" size="sm" color="secondary" maxLines={1} className="min-w-0">
                        {items![index].description}
                      </Text>
                    )}
                  </HStack>
                }
                isSelected={row === selected}
                onClick={() => {
                  if (!multi) return answer({ type: 'pick', indices: [index] });
                  setSelected(row);
                  toggleMark(index);
                }}
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
      {multi && (
        <HStack gap={4} className="shrink-0">
          <KeyHint keys={['tab']} label="mark" onPress={pressHint} />
          <KeyHint keys={['enter']} label="choose" onPress={pressHint} />
        </HStack>
      )}
    </Card>
  );
}
