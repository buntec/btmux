// macOS Cmd editing chords → terminal input (`macos-edit-keys`).

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

type KeyInit = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/** Readline keys, as Ghostty binds them; Cmd+Delete's C-k is btmux's. */
const CMD_KEYS: Record<string, string> = {
  ArrowLeft: '\x01',
  ArrowRight: '\x05',
  Backspace: '\x15',
  Delete: '\x0b',
};

/** Shift+Cmd+arrow with xterm modifier 10 (shift + super), as Ghostty encodes it. */
const SHIFT_CMD_KEYS: Record<string, string> = {
  ArrowLeft: '\x1b[1;10D',
  ArrowRight: '\x1b[1;10C',
};

/** Whether an event targets a pane's terminal (`PaneTerminal` marks its element). */
export function inPaneTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-pane-terminal]') !== null;
}

/** Bytes for a macOS Cmd editing chord, or null for other keys. */
export function macEditKey(e: KeyInit, mac = IS_MAC): string | null {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey) return null;
  return (e.shiftKey ? SHIFT_CMD_KEYS[e.key] : CMD_KEYS[e.key]) ?? null;
}
