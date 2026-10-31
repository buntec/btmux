/** A touchscreen is the primary pointer, as wterm decides for its input. */
export const TOUCH_QUERY = '(pointer: coarse)';

export const isTouchPrimary = () => window.matchMedia?.(TOUCH_QUERY).matches ?? false;

/** Phone-width screens, as ConfigPage and SessionSwitcher lay out. */
export const NARROW_QUERY = '(max-width: 767px)';

/** Stop iOS capitalizing and autocorrecting an input; TextInput doesn't forward these. */
export function plainTextInput(input: HTMLInputElement | null) {
  input?.setAttribute('autocapitalize', 'off');
  input?.setAttribute('autocorrect', 'off');
}
