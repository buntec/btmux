import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { CommandPalette } from '@astryxdesign/core/CommandPalette';
import { createStaticSource } from '@astryxdesign/core/Typeahead';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Kbd } from '@astryxdesign/core/Kbd';
import { List, ListItem } from '@astryxdesign/core/List';
import { Layout, LayoutContent, LayoutFooter, HStack, VStack, Section } from '@astryxdesign/core/Layout';
import { InfoDialog } from './InfoDialog';
import { useStore } from '../state/store';
import type { ClientMessage } from '../protocol/messages';
import type { ClientConfig } from '../state/types';
import { getPrefix } from '../state/configDefaults';

/** Ordered keybinding-help sections, each matching a set of action names. */
const KEY_SECTIONS: { title: string; actions: string[] }[] = [
  {
    title: 'Panes',
    actions: [
      'split-horizontal',
      'split-vertical',
      'navigate-left',
      'navigate-right',
      'navigate-up',
      'navigate-down',
      'zoom-pane',
      'kill-pane',
      'next-pane',
      'last-pane',
      'swap-pane-back',
      'swap-pane-forward',
      'next-layout',
      'display-panes',
      'capture-pane',
      'toggle-latex',
      'file-browser',
      'git-view',
      'process-view',
    ],
  },
  {
    title: 'Windows',
    actions: [
      'new-window',
      'next-window',
      'prev-window',
      'last-window',
      'rename-window',
      'window-grid',
      'agent-grid',
      'kill-window',
    ],
  },
  {
    title: 'Sessions',
    actions: [
      'choose-session',
      'new-session',
      'rename-session',
      'kill-session',
      'next-session',
      'prev-session',
      'last-session',
    ],
  },
  {
    title: 'General',
    actions: [
      'command-palette',
      'list-keys',
      'choose-colors',
      'choose-font',
      'choose-font-weight',
      'choose-shader',
      'choose-pane-switch-shader',
    ],
  },
];

interface Props {
  sessionId: string;
  send: (message: ClientMessage) => void;
  config: ClientConfig | null;
}

export function Overlay({ sessionId, send, config }: Props) {
  const overlay = useStore((state) => state.overlay);
  const setOverlay = useStore((state) => state.setOverlay);
  const navigate = useNavigate();
  const [pickerIndex, setPickerIndex] = useState(0);
  const [applied, setApplied] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const source = useMemo(() => createStaticSource(overlay?.mode === 'command' ? overlay.commands : []), [overlay]);
  useEffect(() => {
    if (overlay?.mode !== 'picker') return;
    setPickerIndex(
      Math.max(
        0,
        overlay.items.findIndex((item) => item.active),
      ),
    );
    setApplied(null);
  }, [overlay?.mode, overlay?.title]);
  useEffect(() => {
    if (overlay?.mode === 'picker') {
      pickerRef.current?.querySelector<HTMLElement>('[aria-selected="true"] button')?.focus();
    }
  }, [pickerIndex, overlay?.mode, config]);
  if (!overlay) return null;
  const close = () => setOverlay(overlay.mode === 'confirm' ? (overlay.returnTo ?? null) : null);
  const changeOpen = (open: boolean) => {
    if (!open) close();
  };
  if (overlay.mode === 'info') return <InfoDialog onClose={close} />;
  if (overlay.mode === 'confirm')
    return (
      <AlertDialog
        isOpen
        onOpenChange={changeOpen}
        title="Confirm action"
        description={overlay.title}
        actionLabel="Confirm"
        onAction={() => {
          overlay.onConfirm();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === 'y') {
            event.preventDefault();
            overlay.onConfirm();
            close();
          }
          if (event.key === 'n') {
            event.preventDefault();
            close();
          }
          event.stopPropagation();
        }}
      />
    );
  if (overlay.mode === 'command')
    return (
      <CommandPalette
        isOpen
        label={overlay.title}
        searchSource={source}
        onOpenChange={(open) => {
          if (!open && useStore.getState().overlay === overlay) setOverlay(null);
        }}
        onValueChange={(id) => {
          const command = overlay.commands.find((item) => item.id === id);
          if (!command) return;
          const state = useStore.getState();
          if (id === 'open-config') {
            setOverlay(null);
            state.setSettingsOpen(true);
            return;
          }
          if (id === 'toggle-latex') {
            const pane = state.getActivePaneId(sessionId);
            if (pane) state.toggleLatex(pane);
            setOverlay(null);
            return;
          }
          const run = () => send({ type: 'run_command', command: id, session_id: sessionId });
          if (command.confirm) setOverlay({ mode: 'confirm', title: command.confirm, onConfirm: run });
          else {
            run();
            setOverlay(null);
          }
        }}
        renderItem={(item) => (
          <VStack gap={0.5}>
            <Text>{item.label}</Text>
            <Text color="secondary">{item.description}</Text>
          </VStack>
        )}
      />
    );
  if (overlay.mode === 'prompt') {
    const submit = () => {
      const name = overlay.value.trim();
      const target = overlay.targetSessionId ?? sessionId;
      if (overlay.action === 'new-session') send({ type: 'create_session', name: name || null });
      else if (name && overlay.action === 'rename-window') send({ type: 'rename_window', session_id: target, name });
      else if (name) {
        send({ type: 'rename_session', session_id: target, name });
        if (target === sessionId) navigate(`/s/${encodeURIComponent(name)}`, { replace: true });
      }
      close();
    };
    return (
      <Dialog isOpen onOpenChange={changeOpen} purpose="form">
        <Layout
          header={<DialogHeader title={overlay.title} onOpenChange={changeOpen} />}
          content={
            <LayoutContent padding={4}>
              <TextInput
                label="Name"
                value={overlay.value}
                hasAutoFocus
                onChange={(value) => setOverlay({ ...overlay, value })}
                onEnter={submit}
              />
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="end">
                <Button label="Cancel" onClick={close} />
                <Button label="Save" variant="primary" onClick={submit} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    );
  }
  if (overlay.mode === 'picker') {
    const select = (index: number, finish = false) => {
      const item = overlay.items[index];
      if (!item) return;
      setPickerIndex(index);
      overlay.onSelect(item.id);
      setApplied(item.id);
      if (finish) close();
    };
    return (
      <Dialog
        isOpen
        onOpenChange={changeOpen}
        width={640}
        onKeyDown={(event) => {
          event.stopPropagation();
          const count = overlay.items.length;
          if (!count) return;
          const direction =
            event.key === 'ArrowDown' || event.key === 'j' || (event.ctrlKey && event.key === 'n')
              ? 1
              : event.key === 'ArrowUp' || event.key === 'k' || (event.ctrlKey && event.key === 'p')
                ? -1
                : 0;
          if (direction) {
            event.preventDefault();
            setPickerIndex((pickerIndex + direction + count) % count);
          }
          if (event.key === ' ') {
            event.preventDefault();
            select(pickerIndex);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            select(pickerIndex, true);
          }
        }}
      >
        <Layout
          header={<DialogHeader title={overlay.title} onOpenChange={changeOpen} />}
          content={
            <LayoutContent ref={pickerRef} padding={0}>
              <List density="compact">
                {overlay.items.map((item, index) => (
                  <ListItem
                    key={item.id}
                    label={item.label}
                    isSelected={index === pickerIndex}
                    endContent={
                      (applied === null ? item.active : applied === item.id) ? (
                        <Text color="secondary">Applied</Text>
                      ) : undefined
                    }
                    onClick={() => select(index)}
                  />
                ))}
              </List>
              {!overlay.items.length && (
                <Section>
                  <Text color="secondary">No items available.</Text>
                </Section>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="between">
                <Text color="secondary">Space to apply · Enter to confirm</Text>
                <Button label="Done" onClick={close} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    );
  }
  const sections = [
    ...KEY_SECTIONS,
    {
      title: 'Other',
      actions: overlay.binds
        .filter((bind) => !KEY_SECTIONS.some((section) => section.actions.includes(bind.action)))
        .map((bind) => bind.action),
    },
  ];
  return (
    <Dialog
      isOpen
      onOpenChange={changeOpen}
      width={960}
      maxHeight="85dvh"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Layout
        header={
          <DialogHeader
            title={overlay.title}
            subtitle={`Press ${getPrefix(config)}, then a key`}
            onOpenChange={changeOpen}
          />
        }
        content={
          <LayoutContent padding={4}>
            <VStack gap={6}>
              {sections.map((section) => {
                const binds = overlay.binds.filter((bind) => section.actions.includes(bind.action));
                return binds.length ? (
                  <Section key={section.title}>
                    <Heading level={3}>{section.title}</Heading>
                    <List density="compact" hasDividers>
                      {binds.map((bind) => (
                        <ListItem
                          key={`${bind.action}:${bind.key}`}
                          label={bind.action.replace(/-/g, ' ')}
                          endContent={<Kbd keys={bind.key === ' ' ? 'Space' : bind.key} />}
                        />
                      ))}
                    </List>
                  </Section>
                ) : null;
              })}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
