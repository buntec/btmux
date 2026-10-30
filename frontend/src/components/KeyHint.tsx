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

/** Compact key-cap hint for overlay footers. */
export function KeyHint({ keys, label }: Hint) {
  return (
    <HStack gap={1} vAlign="center" className="flex-none">
      {keys.map((key) => (
        <KeyCap key={key} keys={key} />
      ))}
      {typeof label === 'string' ? (
        <Text size="sm" color="secondary">
          {label}
        </Text>
      ) : (
        label
      )}
    </HStack>
  );
}
