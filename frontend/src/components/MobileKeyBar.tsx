import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HStack } from '@astryxdesign/core/Layout';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Command, KeyboardOff, SquareSplitHorizontal } from 'lucide-react';
import { useStore } from '../state/store';
import { CONFIG_DEFAULTS, getPrefix } from '../state/configDefaults';
import { parsePrefix } from '../lib/prefixKey';
import { runAction } from '../hooks/useKeybindings';
import { dispatchKey, type KeyModifiers } from '../lib/paneTerminal';
import type { ClientMessage } from '../protocol/messages';

const ARROWS = [
  { key: 'ArrowLeft', label: 'Left', icon: ArrowLeft },
  { key: 'ArrowDown', label: 'Down', icon: ArrowDown },
  { key: 'ArrowUp', label: 'Up', icon: ArrowUp },
  { key: 'ArrowRight', label: 'Right', icon: ArrowRight },
];

// Inputs the key bar types into: pane terminals and the built-in Neovim.
const takesKeys = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[data-pane-terminal], [data-nvim-input]') !== null;

/** Keys phone keyboards lack. Ctrl and Alt apply to the next key, from here or the keyboard. */
export function MobileKeyBar({ sessionId, send }: { sessionId: string; send: (message: ClientMessage) => void }) {
  const navigate = useNavigate();
  const config = useStore((state) => state.config);
  const prefixActive = useStore((state) => state.prefixActive);
  const paneCount = useStore((state) => {
    const session = state.allSessions.find((session) => session.id === sessionId);
    return session?.windows[session.active_window]?.panes.length ?? 0;
  });
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const prefix = parsePrefix(getPrefix(config)) ?? parsePrefix(CONFIG_DEFAULTS.prefix)!;

  // To the focused terminal or Neovim, else what covers the active pane.
  const pressKey = (key: string, modifiers: KeyModifiers) => {
    const state = useStore.getState();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.dataset.nvimInput !== undefined) {
      return dispatchKey(focused, key, modifiers);
    }
    const pane = focused?.closest('[data-pane-terminal]');
    for (const term of state.terminals.values()) if (term.element === pane) return term.pressKey(key, modifiers);
    const paneId = state.getActivePaneId(sessionId);
    if (!paneId) return;
    if (state.nvimOpen && state.nvimPaneId === paneId) {
      const input = document.querySelector('[data-nvim-input]');
      if (input) dispatchKey(input, key, modifiers);
      return;
    }
    // VS Code's iframe ignores synthetic keys; they mustn't reach the shell under it.
    if (state.vscodeOpen && state.vscodePaneId === paneId) return;
    state.terminals.get(paneId)?.pressKey(key, modifiers);
  };

  const press = (key: string) => {
    pressKey(key, { ctrlKey: ctrl, altKey: alt });
    setCtrl(false);
    setAlt(false);
  };

  const run = (action: string) =>
    runAction(action, sessionId, send, (name) => navigate(`/s/${encodeURIComponent(name)}`));

  // While armed, the next character typed on the keyboard takes the modifiers, or the prefix's binding.
  useEffect(() => {
    if (!ctrl && !alt && !prefixActive) return;
    let armed = true;
    const take = (event: Event, key: string) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      armed = false;
      press(key);
    };
    // One character takes them; longer text (a suggestion) goes through and disarms them.
    const typed = (event: Event, text: string | null): text is string => {
      if (!armed || !text || !takesKeys(event.target)) return false;
      if ([...text].length === 1) return true;
      armed = false;
      setCtrl(false);
      setAlt(false);
      useStore.getState().setPrefixActive(false);
      return false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Keys typed after the prefix reach useKeybindings themselves.
      if (!(ctrl || alt) || !event.isTrusted || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
        return;
      }
      if ([...event.key].length === 1 && typed(event, event.key)) take(event, event.key);
    };
    // Android keyboards send text without key events, or compose it.
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertText' && typed(event, event.data)) take(event, event.data);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (!typed(event, event.data)) return;
      // End the composition without its text, which goes as the key instead.
      const input = event.target as HTMLTextAreaElement;
      input.value = '';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      take(event, event.data);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('beforeinput', onBeforeInput, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('beforeinput', onBeforeInput, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
    };
  }, [ctrl, alt, prefixActive]);

  return (
    <HStack
      gap={1}
      paddingInline={2}
      paddingBlock={1}
      vAlign="center"
      className="btm-mono"
      aria-label="Terminal keys"
      // Keep the keyboard open: taps here mustn't take focus from the terminal.
      // Not on pointerdown, which cancels a tap's click in WebKit.
      onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
    >
      {/* Scroll sideways rather than truncate the keys. */}
      <HStack gap={1} vAlign="center" isScrollable className="min-w-0 flex-1 [&>*]:shrink-0">
        <Button label="Esc" size="sm" variant="ghost" onClick={() => press('Escape')} />
        <Button label="Tab" size="sm" variant="ghost" onClick={() => press('Tab')} />
        <ToggleButton label="Ctrl" size="sm" isPressed={ctrl} onPressedChange={setCtrl} />
        <ToggleButton label="Alt" size="sm" isPressed={alt} onPressedChange={setAlt} />
        {ARROWS.map(({ key, label, icon: Icon }) => (
          <IconButton key={key} label={label} size="sm" variant="ghost" icon={<Icon />} onClick={() => press(key)} />
        ))}
        <ToggleButton
          label={`Prefix (${getPrefix(config)})`}
          size="sm"
          isPressed={prefixActive}
          onPressedChange={(pressed) =>
            pressed
              ? pressKey(prefix.key, { ctrlKey: prefix.ctrl, altKey: prefix.alt })
              : useStore.getState().setPrefixActive(false)
          }
        >
          {getPrefix(config)}
        </ToggleButton>
        {paneCount > 1 && (
          <IconButton
            label="Next pane"
            size="sm"
            variant="ghost"
            icon={<SquareSplitHorizontal />}
            onClick={() => run('next-pane')}
          />
        )}
        <IconButton
          label="Commands"
          size="sm"
          variant="ghost"
          icon={<Command />}
          onClick={() => run('command-palette')}
        />
      </HStack>
      {/* iPhone keyboards have no dismiss key. */}
      <IconButton
        label="Hide keyboard"
        size="sm"
        variant="ghost"
        icon={<KeyboardOff />}
        onClick={() => (document.activeElement as HTMLElement | null)?.blur()}
      />
    </HStack>
  );
}
