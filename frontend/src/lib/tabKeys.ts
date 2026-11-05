import type { KeyboardEvent } from 'react';
import { stepIndex } from './utils';

const CONTROLS = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const PANEL = '[role="tabpanel"]';
const TABLIST = '[role="tablist"]';

/** Whether the key is the dialog's to handle: controls outside the tab strip keep theirs. */
function navigates(e: KeyboardEvent<HTMLElement>): boolean {
  const target = e.target as Element;
  // Portaled content bubbles here too.
  return e.currentTarget.contains(target) && (!target.matches(CONTROLS) || !!target.closest(TABLIST));
}

/**
 * Tab and Shift+Tab cycle a dialog's tabs from its background, heading, tab
 * strip, or a panel without controls; call this from the dialog's `onKeyDown`.
 * Everywhere else, Tab keeps moving between controls.
 */
export function cycleTabs<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  tabs: readonly T[],
  value: T,
  onChange: (value: T) => void,
): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  const target = e.target as Element;
  const inPanel = !!target.closest(PANEL);
  if (!navigates(e) || (inPanel && !target.matches(PANEL))) return false;
  e.preventDefault();
  const index = stepIndex(tabs.indexOf(value), e.shiftKey ? -1 : 1, tabs.length, true);
  // Focus left on the old tab would reselect it on Enter.
  const tablist = target.closest(TABLIST);
  if (tablist) tablist.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  // The panel may unmount, which would drop focus out of the dialog.
  else if (inPanel) e.currentTarget.focus();
  onChange(tabs[index]);
  return true;
}

/**
 * ArrowDown moves into the shown panel, as Tab no longer does: to its first
 * control, else the panel itself, so the keyboard can scroll it.
 */
export function enterTabPanel(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== 'ArrowDown' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  if (!navigates(e) || (e.target as Element).closest(PANEL)) return false;
  const panel = [...e.currentTarget.querySelectorAll<HTMLElement>(PANEL)].find((item) => item.checkVisibility());
  if (!panel) return false;
  const control = [...panel.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (item) => !item.matches(':disabled') && item.checkVisibility(),
  );
  e.preventDefault();
  if (!control) panel.tabIndex = -1;
  (control ?? panel).focus();
  return true;
}
