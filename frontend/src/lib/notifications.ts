import type { NotificationLevel } from '../protocol/messages';

export interface Notification {
  message: string;
  level: NotificationLevel;
  body?: string;
  paneId?: string;
  /** Stays until dismissed. */
  persistent?: boolean;
  /** Replaces a shown notification with the same id; `dismissNotification` removes it. */
  id?: string;
  action?: NotificationAction;
}

/** `run` gets a callback that dismisses its notification. */
export interface NotificationAction {
  label: string;
  run: (dismiss: () => void) => void;
}

export interface NotificationSink {
  show: (notification: Notification) => void;
  dismiss: (id: string) => void;
}

const RANK: Record<NotificationLevel, number> = { info: 0, success: 1, attention: 2, error: 3 };

/** Whether `level` is at least as severe as `min`. */
export function atLeast(level: NotificationLevel, min: NotificationLevel) {
  return RANK[level] >= RANK[min];
}

let sink: NotificationSink | null = null;
let pending: Notification[] = [];

export function showNotification(notification: Notification) {
  if (sink) sink.show(notification);
  else {
    if (notification.id) pending = pending.filter((n) => n.id !== notification.id);
    pending.push(notification);
    if (pending.length > 20) pending.shift();
  }
}

export function dismissNotification(id: string) {
  if (sink) sink.dismiss(id);
  else pending = pending.filter((n) => n.id !== id);
}

export function subscribeNotifications(next: NotificationSink) {
  sink = next;
  const queued = pending;
  pending = [];
  for (const notification of queued) next.show(notification);
  return () => {
    if (sink === next) sink = null;
  };
}
