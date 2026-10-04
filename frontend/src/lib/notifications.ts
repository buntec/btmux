import type { NotificationLevel } from '../protocol/messages';

export interface Notification {
  message: string;
  level: NotificationLevel;
  body?: string;
  paneId?: string;
}

let sink: ((notification: Notification) => void) | null = null;
const pending: Notification[] = [];

export function showNotification(notification: Notification) {
  if (sink) sink(notification);
  else {
    pending.push(notification);
    if (pending.length > 20) pending.shift();
  }
}

export function subscribeNotifications(next: (notification: Notification) => void) {
  sink = next;
  for (const notification of pending.splice(0)) next(notification);
  return () => {
    if (sink === next) sink = null;
  };
}
