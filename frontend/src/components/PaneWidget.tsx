import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { WidgetKind, WidgetRequest } from '../generated/protocol';
import { isCancelKey, usePaneWidget, type PaneWidgetProps } from '../hooks/usePaneWidget';
import { plainTextInput } from '../lib/touch';
import { PanePicker } from './PanePicker';

const LOAD_ERROR = "Couldn't load this. Esc cancels.";

export function PaneWidget({ kind, ...props }: PaneWidgetProps & { kind: WidgetKind }) {
  if (kind === 'pick') return <PanePicker {...props} />;
  if (kind === 'confirm') return <PaneConfirm {...props} />;
  return <PaneInput {...props} />;
}

/** `btmux confirm`: a question with Yes and No at the pane's cursor. */
function PaneConfirm(props: PaneWidgetProps) {
  const { term } = props;
  const widget = usePaneWidget<Extract<WidgetRequest, { type: 'confirm' }>>(props);
  const { request, failed, cardRef, cardProps } = widget;
  const [moved, setMoved] = useState<boolean | null>(null);
  const yes = moved ?? request?.default_yes ?? false;
  const yesRef = useRef<HTMLButtonElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const button = yes ? yesRef.current : noRef.current;
    term.setFocusTarget(button);
    if (cardRef.current?.contains(document.activeElement)) button?.focus();
  }, [term, yes, cardRef]);

  // Nothing is agreed to before the question has been shown.
  const answer = (value: boolean) => {
    if (request) widget.answer({ type: 'confirm', yes: value });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (isCancelKey(e)) {
      e.preventDefault();
      widget.answer(null);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (['ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
      e.preventDefault();
      setMoved(!yes);
    } else if (key === 'y' || key === 'n' || e.key === 'Enter') {
      e.preventDefault();
      // A key still held from starting the command isn't an answer.
      if (!e.repeat) answer(e.key === 'Enter' ? yes : key === 'y');
    }
  };

  return (
    <Card {...cardProps} padding={2} maxWidth="72ch">
      <Text className="min-h-0 max-h-80 flex-1 overflow-y-auto wrap-anywhere whitespace-pre-wrap">
        {failed ? LOAD_ERROR : request?.message}
      </Text>
      <HStack gap={1} hAlign="end" className="shrink-0" onKeyDown={onKeyDown}>
        <Button
          ref={noRef}
          label="No"
          size="sm"
          variant={yes ? 'secondary' : 'primary'}
          onClick={() => answer(false)}
        />
        <Button
          ref={yesRef}
          label="Yes"
          size="sm"
          variant={yes ? 'primary' : 'secondary'}
          onClick={() => answer(true)}
        />
      </HStack>
    </Card>
  );
}

/** `btmux input`: a line of text at the pane's cursor. */
function PaneInput(props: PaneWidgetProps) {
  const { term } = props;
  const widget = usePaneWidget<Extract<WidgetRequest, { type: 'input' }>>(props);
  const { request, failed, cardProps } = widget;
  const [edited, setEdited] = useState<string | null>(null);
  const value = edited ?? request?.default ?? '';
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    term.setFocusTarget(inputRef.current);
  }, [term]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (isCancelKey(e)) {
      e.preventDefault();
      widget.answer(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (request) widget.answer({ type: 'input', text: value });
    }
  };

  return (
    <Card {...cardProps} padding={2} width="48ch">
      <TextInput
        ref={(input) => {
          plainTextInput(input);
          inputRef.current = input;
        }}
        label={request?.prompt ?? 'Text'}
        isLabelHidden={!request?.prompt}
        size="sm"
        autoComplete="off"
        value={value}
        onChange={setEdited}
        onKeyDown={onKeyDown}
      />
      {failed && (
        <Text size="sm" color="secondary">
          {LOAD_ERROR}
        </Text>
      )}
    </Card>
  );
}
