import type { KeyboardEvent } from 'react';
import { stepIndex } from './utils';

const CONTROLS = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Tab and Shift+Tab cycle a dialog's tabs. Inside a panel, Tab keeps moving
 * between its controls; call this from the dialog's `onKeyDown`.
 */
export function cycleTabs<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  tabs: readonly T[],
  value: T,
  onChange: (value: T) => void,
): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  const target = e.target as Element;
  // Portaled content bubbles here too.
  if (!e.currentTarget.contains(target) || target.closest('[role="tabpanel"]')) return false;
  e.preventDefault();
  const index = stepIndex(tabs.indexOf(value), e.shiftKey ? -1 : 1, tabs.length, true);
  // Focus left on the old tab would reselect it on Enter.
  const tablist = target.closest('[role="tablist"]');
  if (tablist) tablist.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  onChange(tabs[index]);
  return true;
}

/** ArrowDown moves from outside the shown panel to its first control, as Tab no longer does. */
export function enterTabPanel(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== 'ArrowDown' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  const target = e.target as Element;
  if (!e.currentTarget.contains(target) || target.closest('[role="tabpanel"]')) return false;
  const panel = [...e.currentTarget.querySelectorAll('[role="tabpanel"]')].find((item) => item.checkVisibility());
  const control = [...(panel?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])].find(
    (item) => !item.matches(':disabled') && item.checkVisibility(),
  );
  if (!control) return false;
  e.preventDefault();
  control.focus();
  return true;
}
