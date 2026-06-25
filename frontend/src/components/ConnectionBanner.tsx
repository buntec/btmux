import { useStore } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';

// Shown when the /ws/control socket is down (e.g. the server went away). The
// frontend holds no canonical state, so while disconnected the UI is stale;
// the socket auto-reconnects every 2s (see useControlSocket.ts).
export function ConnectionBanner() {
  const connected = useStore((s) => s.controlConnected);
  const theme = useStore((s) => s.config?.theme);

  if (connected) return null;

  const fg = theme?.brightWhite ?? DEFAULT_THEME.brightWhite;
  const bg = theme?.red ?? DEFAULT_THEME.red;

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: bg,
        color: fg,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        fontSize: '13px',
        textAlign: 'center',
        padding: '6px 8px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
      }}
    >
      Connection lost — trying to reconnect…
    </div>
  );
}
