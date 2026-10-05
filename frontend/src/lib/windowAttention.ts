import { useSyncExternalStore } from 'react';

/** Whether the user is looking at this window: visible and focused. */
export function windowAttended() {
  return !document.hidden && document.hasFocus();
}

function subscribe(onChange: () => void) {
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

export function useWindowAttended() {
  return useSyncExternalStore(subscribe, windowAttended);
}
