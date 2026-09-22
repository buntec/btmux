// Shared state model + copy for the app's several auto-reconnecting
// WebSockets (control, pane PTY, sysstat, files), so "connecting" reads the
// same way everywhere instead of each socket inventing its own wording.
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

export const CONNECTION_STATE_LABEL: Record<Exclude<ConnectionState, 'connected'>, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
};
