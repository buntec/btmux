import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { WidgetAnswer, WidgetRequest } from '../generated/protocol';
import type { PaneTerminal } from '../lib/paneTerminal';
import type { ClientMessage } from '../protocol/messages';
import { useStore } from '../state/store';

export interface PaneWidgetProps {
  id: string;
  term: PaneTerminal;
  /** The tab can see this pane. */
  shown: boolean;
  send: (msg: ClientMessage) => void;
}

export const isCancelKey = (e: KeyboardEvent) => e.key === 'Escape' || (e.ctrlKey && e.key === 'c');

/**
 * What every `btmux` widget shares: reporting that it's shown, loading its
 * request, answering, and sitting at the pane's cursor. The caller sets
 * `term.setFocusTarget`, which this clears, and spreads `cardProps` on a `Card`.
 */
export function usePaneWidget<R extends WidgetRequest>({ id, term, shown, send }: PaneWidgetProps) {
  const [request, setRequest] = useState<R | null>(null);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // The first size, kept so that filtering never moves a menu's input.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (shown) send({ type: 'widget_shown', id });
  }, [shown, id, send]);

  useEffect(() => {
    if (!shown || request) return;
    let canceled = false;
    fetch(`/api/widgets/${id}`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<R>) : Promise.reject()))
      .then((loaded) => {
        if (!canceled) setRequest(loaded);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [shown, id, request]);

  useLayoutEffect(() => {
    term.scrollToBottom();
    return () => term.setFocusTarget(null);
  }, [term]);

  useLayoutEffect(() => {
    if (!shown || (!request && !failed) || size) return;
    const card = cardRef.current;
    if (card?.offsetParent) setSize({ width: card.offsetWidth, height: card.offsetHeight });
  }, [shown, request, failed, size]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const surface = card?.offsetParent;
    if (!card || !surface || !size) return;
    const place = () => {
      const bounds = surface.getBoundingClientRect();
      const anchor = term.cursorRect();
      const top = Math.max(0, Math.min(anchor.top - bounds.top, bounds.height));
      const bottom = Math.max(0, Math.min(anchor.bottom - bounds.top, bounds.height));
      const below = bounds.height - bottom;
      const above = size.height > below && top > below;
      const width = Math.min(size.width, bounds.width);
      card.style.width = `${width}px`;
      card.style.height = `${Math.min(size.height, above ? top : below)}px`;
      card.style.top = above ? '' : `${bottom}px`;
      card.style.bottom = above ? `${bounds.height - top}px` : '';
      card.style.left = `${Math.max(0, Math.min(anchor.left - bounds.left, bounds.width - width))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(surface);
    // Output can arrive after the widget: they come over different sockets.
    const offRender = term.onRender(place);
    return () => {
      observer.disconnect();
      offRender();
    };
  }, [term, size, shown]);

  const answer = (value: WidgetAnswer | null) => {
    send({ type: 'widget_answer', id, answer: value });
    // Other tabs close when the server's update arrives.
    const store = useStore.getState();
    store.setWidgets(store.widgets.filter((widget) => widget.id !== id));
  };

  const cardProps = {
    ref: cardRef,
    padding: 1,
    elevation: 'high',
    'data-pane-widget': '',
    // A click on its text or padding leaves its keys with it.
    onClick: () => term.focus(),
    className: `btm-mono absolute z-5 flex min-h-0 min-w-[24ch] flex-col gap-1 overflow-hidden ${size ? '' : 'opacity-0'}`,
  } as const;

  return { request, failed, measured: size !== null, answer, cardRef, cardProps };
}
