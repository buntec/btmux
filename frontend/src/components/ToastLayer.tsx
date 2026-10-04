import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { VStack } from '@astryxdesign/core/Layout';

const toastOptions = { position: 'topEnd' as const };

export function ToastLayer({ children }: { children: ReactNode }) {
  const [appHost, setAppHost] = useState<HTMLElement | null>(null);
  const [toastHost] = useState(() => document.createElement('div'));

  useEffect(() => {
    let modals: HTMLDialogElement[] = [];

    const promote = () => {
      const viewport = toastHost.querySelector<HTMLElement>('[popover="manual"]');
      if (!viewport || typeof viewport.showPopover !== 'function') return;
      if (viewport.matches(':popover-open')) viewport.hidePopover();
      viewport.showPopover();
    };

    const sync = (records: MutationRecord[] = []) => {
      const open = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')];
      let opened = false;
      modals = modals.filter((dialog) => open.includes(dialog));
      for (const { type, target } of records) {
        if (type === 'attributes' && target instanceof HTMLDialogElement && open.includes(target)) {
          opened = true;
          modals = modals.filter((dialog) => dialog !== target);
          modals.push(target);
        }
      }
      for (const dialog of open) {
        if (!modals.includes(dialog)) modals.push(dialog);
      }

      // Modal descendants remain interactive; the stable portal host keeps toast state.
      const parent = modals[modals.length - 1] ?? document.body;
      if (toastHost.parentElement !== parent) {
        parent.appendChild(toastHost);
        promote();
      } else if (opened) {
        promote();
      }
    };

    const onToggle = (event: Event) => {
      if (!(event.target instanceof HTMLElement) || toastHost.contains(event.target)) return;
      if ((event as ToggleEvent).newState === 'open') {
        sync();
        promote();
      }
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('toggle', onToggle, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('toggle', onToggle, true);
      toastHost.remove();
    };
  }, [toastHost]);

  return (
    <>
      <VStack ref={setAppHost} className="contents" />
      {/* Keep the app mounted in place while its shared toast host follows the modal. */}
      {appHost &&
        createPortal(<LayerProvider toast={toastOptions}>{createPortal(children, appHost)}</LayerProvider>, toastHost)}
    </>
  );
}
