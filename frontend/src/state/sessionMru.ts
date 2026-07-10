import { SessionState, SessionSort } from './types';

const SESSION_MRU_KEY = 'btmux-session-mru';

export function getSessionMruOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_MRU_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordSessionMruVisit(sessionId: string): void {
  const order = getSessionMruOrder().filter((id) => id !== sessionId);
  order.unshift(sessionId);
  localStorage.setItem(SESSION_MRU_KEY, JSON.stringify(order.slice(0, 64)));
}

export function sortSessions(sessions: SessionState[], sort: SessionSort | string): SessionState[] {
  if (sort === 'alphabetical') {
    return [...sessions].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sort === 'mru') {
    const order = getSessionMruOrder();
    return [...sessions].sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }
  return sessions;
}
