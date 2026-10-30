import type { ReactNode } from 'react';
import { HStack } from '@astryxdesign/core/Layout';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Text } from '@astryxdesign/core/Text';

export interface Hint {
  keys: string[];
  label: ReactNode;
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'mod']);
const TMUX_MODIFIERS: Record<string, string> = { C: 'ctrl', M: 'alt', S: 'shift' };

/** Split `ctrl+p` or tmux-style `C-p` into modifiers and the final key. */
function parseKeys(keys: string): { modifiers: string[]; key: string } {
  const tmux = keys.match(/^((?:[CMS]-)+)(.+)$/);
  if (tmux) {
    const modifiers = tmux[1]
      .split('-')
      .filter(Boolean)
      .map((m) => TMUX_MODIFIERS[m]);
    return { modifiers, key: tmux[2] };
  }
  const parts = keys.length > 1 ? keys.split('+') : [keys];
  if (parts.length > 1 && parts.slice(0, -1).every((part) => MODIFIERS.has(part.toLowerCase()))) {
    return { modifiers: parts.slice(0, -1).map((part) => part.toLowerCase()), key: parts[parts.length - 1] };
  }
  return { modifiers: [], key: keys };
}

// Hint key names as KeyboardEvent.key values.
const KEY_VALUES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/** The keydown a hint key such as `ctrl+d`, `G`, or `esc` stands for. */
export function hintKeyEvent(keys: string): KeyboardEventInit {
  const { modifiers, key } = parseKeys(keys);
  const value = KEY_VALUES[key.toLowerCase()] ?? key;
  return {
    key: value,
    ctrlKey: modifiers.includes('ctrl'),
    altKey: modifiers.includes('alt'),
    shiftKey: modifiers.includes('shift') || (value.length === 1 && value !== value.toLowerCase()),
    bubbles: true,
    cancelable: true,
  };
}

/** Keys Kbd draws as glyphs or a readable name; it would uppercase others. */
const KBD_KEYS = new Set(['enter', 'return', 'backspace', 'escape', 'esc', 'up', 'down', 'left', 'right', 'plus']);

// Kbd's Tab glyph (⇥) reads as a right arrow.
const LITERAL_NAMES: Record<string, string> = { space: 'Space', tab: 'Tab', pageup: 'PgUp', pagedown: 'PgDn' };

/**
 * A key cap in literal case. Astryx's Kbd uppercases every key, which hides
 * the difference between case-sensitive bindings like `x` and `X` and shouts
 * names like PAGEDOWN, so only modifiers and keys it has glyphs for (Enter,
 * Esc, arrows) use Kbd; the rest are drawn as typed with Kbd's styling.
 */
export function KeyCap({ keys }: { keys: string }) {
  const { modifiers, key } = parseKeys(keys);
  const named = KEY_NAMES[key] ?? key;
  const final = KBD_KEYS.has(named.toLowerCase()) ? (
    <Kbd keys={named} />
  ) : (
    <kbd className="inline-flex h-5 min-w-5 flex-none select-none items-center justify-center rounded-sm border-b-2 border-b-border-strong bg-neutral px-1 font-sans text-xs font-medium text-secondary">
      {LITERAL_NAMES[named.toLowerCase()] ?? named}
    </kbd>
  );
  if (modifiers.length === 0) return final;
  return (
    <HStack as="span" gap={1} vAlign="center" className="flex-none">
      {modifiers.map((modifier) => (
        <Kbd key={modifier} keys={modifier} />
      ))}
      {final}
    </HStack>
  );
}

function PressableKey({
  keys,
  label,
  onPress,
  children,
}: {
  keys: string;
  label: ReactNode;
  onPress: (keys: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={typeof label === 'string' ? `${keys}: ${label}` : keys}
      className="flex flex-none cursor-pointer items-center gap-1 rounded-sm py-1 hover:bg-overlay-hover"
      // Keep focus (and an open keyboard) where it is.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={() => onPress(keys)}
    >
      {children}
    </button>
  );
}

/** Compact key-cap hint for overlay footers. With `onPress`, tapping a key presses it. */
export function KeyHint({ keys, label, onPress }: Hint & { onPress?: (keys: string) => void }) {
  const text =
    typeof label === 'string' ? (
      <Text size="sm" color="secondary">
        {label}
      </Text>
    ) : (
      label
    );
  // A single key takes its label along, for a larger target.
  if (onPress && keys.length === 1)
    return (
      <PressableKey keys={keys[0]} label={label} onPress={onPress}>
        <KeyCap keys={keys[0]} />
        {text}
      </PressableKey>
    );
  return (
    <HStack gap={1} vAlign="center" className="flex-none">
      {keys.map((key) =>
        onPress ? (
          <PressableKey key={key} keys={key} label={label} onPress={onPress}>
            <KeyCap keys={key} />
          </PressableKey>
        ) : (
          <KeyCap key={key} keys={key} />
        ),
      )}
      {text}
    </HStack>
  );
}
