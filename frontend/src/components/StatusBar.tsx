import { useNavigate } from 'react-router-dom';
import { useStore, PaneNotification } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';
import type { NotificationLevel } from '../protocol/messages';

function prefixLabel(prefix: string): string {
  const parts = prefix.split('-');
  const key = parts.pop() ?? '';
  const mods = parts.map((m) => (m.toUpperCase() === 'C' ? '^' : m.toUpperCase() === 'M' ? 'M-' : m)).join('');
  return `${mods}${key.toUpperCase()}`;
}

interface Props {
  sessionId: string;
}

function notificationColor(level: NotificationLevel, theme: typeof DEFAULT_THEME | null): string {
  const t = theme ?? DEFAULT_THEME;
  switch (level) {
    case 'attention':
      return t.yellow;
    case 'error':
      return t.red;
    case 'success':
      return t.green;
    default:
      return t.blue;
  }
}

function windowNotificationLevel(
  paneIds: string[],
  notifications: Map<string, PaneNotification>,
): NotificationLevel | null {
  let highest: NotificationLevel | null = null;
  const priority: NotificationLevel[] = ['error', 'attention', 'success', 'info'];
  for (const id of paneIds) {
    const n = notifications.get(id);
    if (!n) continue;
    if (!highest) {
      highest = n.level;
      continue;
    }
    if (priority.indexOf(n.level) < priority.indexOf(highest)) highest = n.level;
  }
  return highest;
}

export function StatusBar({ sessionId }: Props) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const prefixActive = useStore((s) => s.prefixActive);
  const notifications = useStore((s) => s.notifications);
  const navigate = useNavigate();
  const fontSize = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));

  const session = allSessions.find((s) => s.id === sessionId);
  if (!session) return null;

  const theme = config?.theme;
  const bg = adjustBrightness(theme?.background ?? DEFAULT_THEME.background, 20);
  const fg = theme?.foreground ?? DEFAULT_THEME.foreground;
  const border = theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;
  const dimFg = theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const winActiveFg = theme?.white ?? DEFAULT_THEME.white;
  const accentFg = theme?.yellow ?? DEFAULT_THEME.yellow;
  const zoomFg = theme?.magenta ?? DEFAULT_THEME.magenta;

  return (
    <div
      style={{
        height: `${fontSize + 12}px`,
        background: bg,
        color: fg,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontSize: `${fontSize}px`,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        borderTop: `1px solid ${border}`,
      }}
    >
      <span style={{ color: dimFg, marginRight: '8px' }}>[{session.name}]</span>
      <span>
        {session.windows.map((w, i) => {
          const winLevel = windowNotificationLevel(
            w.panes.map((p) => p.id),
            notifications,
          );
          return (
            <span
              key={w.id}
              style={{
                marginRight: '8px',
                color: i === session.active_window ? winActiveFg : dimFg,
                fontWeight: i === session.active_window ? 'bold' : 'normal',
              }}
            >
              {i}:{w.name}
              {i === session.active_window ? '*' : ''}
              {w.zoomed_pane && <span style={{ color: zoomFg, fontWeight: 'bold' }}>Z</span>}
              {winLevel && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(w.name)}`);
                  }}
                  style={{
                    color: notificationColor(winLevel, theme ?? null),
                    marginLeft: '2px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  ●
                </span>
              )}
            </span>
          );
        })}
      </span>
      <span style={{ marginLeft: 'auto', color: dimFg }}>
        {prefixActive && <span style={{ color: accentFg }}>{config ? prefixLabel(config.prefix) : '^B'}</span>}
      </span>
    </div>
  );
}

function adjustBrightness(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Perceived luminance — if the background is light, darken; otherwise brighten.
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const dir = luminance > 128 ? -amount : amount;
  const clamp = (v: number) => Math.max(0, Math.min(255, v + dir));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}
