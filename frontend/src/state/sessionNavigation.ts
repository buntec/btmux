/** Pick the neighboring session in stable server order, wrapping at either end. */
export function adjacentSession<T extends { id: string }>(
  sessions: readonly T[],
  currentSessionId: string,
  delta: -1 | 1,
): T | null {
  if (sessions.length < 2) return null;

  const currentIndex = sessions.findIndex((session) => session.id === currentSessionId);
  if (currentIndex < 0) return null;

  return sessions[(currentIndex + delta + sessions.length) % sessions.length] ?? null;
}
