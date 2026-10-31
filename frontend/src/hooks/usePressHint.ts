import { type RefObject, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { dispatchKey } from '@/lib/paneTerminal';
import { TOUCH_QUERY } from '@/lib/touch';
import { hintKey } from '@/components/KeyHint';

export const TEXT_FIELDS = 'input:not([type=checkbox]):not([type=radio]), textarea';

/**
 * A `KeyHint` `onPress` that types the hint's key into `rootRef`'s focused
 * element (or the root), as the keyboard would. `onBeforePress` runs first.
 */
export function usePressHint(rootRef: RefObject<HTMLElement | null>, onBeforePress?: () => void) {
  const touch = useMediaQuery(TOUCH_QUERY);
  return useCallback(
    (keys: string) => {
      const root = rootRef.current;
      if (!root) return;
      onBeforePress?.();
      if (!root.contains(document.activeElement)) root.focus();
      const fields = () =>
        [...root.querySelectorAll<HTMLElement>(TEXT_FIELDS)].filter((field) => field.checkVisibility());
      const existing = new Set(fields());
      const { key, modifiers } = hintKey(keys);
      dispatchKey(document.activeElement ?? root, key, modifiers);
      // iOS opens the keyboard only for focus taken during the tap, so focus a
      // text field the key opened (search, filter, rename) now.
      if (touch && !document.activeElement?.matches(TEXT_FIELDS)) {
        flushSync(() => {});
        fields()
          .find((field) => !existing.has(field))
          ?.focus();
      }
    },
    [rootRef, onBeforePress, touch],
  );
}
