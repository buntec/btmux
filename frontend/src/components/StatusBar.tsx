import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, PaneNotification } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { chromePalette } from '../lib/chrome-colors';
import type { ClientMessage, NotificationLevel } from '../protocol/messages';
import type { Theme } from '../state/types';
import { sortWindows, WINDOW_MRU_EVENT } from '../state/windowMru';
import { SysStatBar } from './SysStatBar';

/**
 * Subscribe to window-MRU changes so an `mru` window sort re-orders the always-
 * visible status bar the instant the active window changes (the order lives in
 * localStorage, which isn't reactive; `recordWindowMruVisit` dispatches a
 * same-tab event). Returns a bump counter used only to force a re-render.
 */
function useWindowMruTick(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(WINDOW_MRU_EVENT, cb);
      return () => window.removeEventListener(WINDOW_MRU_EVENT, cb);
    },
    () => mruTick,
  );
}
// A monotonic counter bumped on each MRU change; getSnapshot must return a
// stable value between changes, so we can't read localStorage directly here.
let mruTick = 0;
if (typeof window !== 'undefined') {
  window.addEventListener(WINDOW_MRU_EVENT, () => {
    mruTick += 1;
  });
}

function prefixLabel(prefix: string): string {
  const parts = prefix.split('-');
  const key = parts.pop() ?? '';
  const mods = parts.map((m) => (m.toUpperCase() === 'C' ? '⌃' : m.toUpperCase() === 'M' ? '⌥' : m)).join('');
  return `${mods}${key.toUpperCase()}`;
}

interface Props {
  sessionId: string;
  send: (msg: ClientMessage) => void;
}

function notificationColor(level: NotificationLevel, theme: Theme | null): string {
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

/**
 * A powerline separator. `color` is the triangle's fill color. `direction`
 * controls which way the arrow points: `'right'` (default, ▶) for left-side
 * transitions (session→window), `'left'` (◀) for right-side entries like the
 * PREFIX indicator. When `fill` is given the triangle sits on a `fill`-colored
 * box for seamless session→active-window joins; only valid for `'right'`.
 */
function Arrow({
  color,
  size,
  fill,
  direction = 'right',
}: {
  color: string;
  size: number;
  fill?: string;
  direction?: 'right' | 'left';
}) {
  const w = Math.round(size * 0.34);
  if (fill) {
    return (
      <div style={{ width: `${w}px`, height: '100%', flex: 'none', position: 'relative', background: fill }}>
        <div
          style={{ position: 'absolute', inset: 0, background: color, clipPath: 'polygon(0 0, 100% 50%, 0 100%)' }}
        />
      </div>
    );
  }
  if (direction === 'left') {
    return (
      <div
        style={{
          width: 0,
          height: '100%',
          borderTop: `${size / 2}px solid transparent`,
          borderBottom: `${size / 2}px solid transparent`,
          borderRight: `${w}px solid ${color}`,
          flex: 'none',
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 0,
        height: '100%',
        borderTop: `${size / 2}px solid transparent`,
        borderBottom: `${size / 2}px solid transparent`,
        borderLeft: `${w}px solid ${color}`,
        flex: 'none',
      }}
    />
  );
}

export function StatusBar({ sessionId, send }: Props) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const prefixActive = useStore((s) => s.prefixActive);
  const notifications = useStore((s) => s.notifications);
  const navigate = useNavigate();
  // Re-render when the window MRU changes so an `mru` sort re-orders live.
  useWindowMruTick();

  // Chrome is compact relative to the terminal font (the design's bar/font ratio),
  // clamped so it stays legible at tiny sizes and doesn't dominate at huge ones.
  const termFont = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));
  const font = Math.max(10, Math.min(17, Math.round(termFont * 0.68)));
  const barH = Math.round(font * 2.15);

  const session = allSessions.find((s) => s.id === sessionId);
  if (!session) return null;

  const c = chromePalette(config?.theme ?? null);
  const animations = config?.animations ?? true;
  const activeWindow = session.windows[session.active_window];
  const paneCount = activeWindow?.panes.length ?? 0;
  const activeZoomed = !!activeWindow?.zoomed_pane;
  // Windows are shown in the configured display order; each keeps its backend
  // index (the switch_window index) while its display position doubles as the
  // shown number and prefix+digit hotkey — see useKeybindings.
  const orderedWindows = sortWindows(session.windows, config?.window_sort ?? 'created');
  // Seamless powerline: when the active window sits first in the *displayed*
  // order, its segment sits directly after the session segment, so the
  // session→window chevron fills into the active-window color (no bar-background
  // gap). Otherwise a plain accent triangle trails into the bar.
  const firstWindowActive = orderedWindows[0]?.index === session.active_window;

  const segPadY = 0;

  // Clicking a window must both switch the backend's active window (the URL
  // alone doesn't — SessionView only sends switch_window on first mount) and
  // navigate, mirroring WindowGrid/SessionSwitcher.
  const goToWindow = (index: number, name: string) => {
    if (index !== session.active_window) {
      send({ type: 'switch_window', session_id: session.id, index });
    }
    navigate(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(name)}`);
  };

  return (
    <div
      style={{
        height: `${barH}px`,
        display: 'flex',
        alignItems: 'stretch',
        background: c.barBg,
        color: c.fg,
        fontSize: `${font}px`,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        borderTop: `1px solid ${c.border}`,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {/* Session segment */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          height: '100%',
          padding: `${segPadY}px 11px ${segPadY}px 13px`,
          background: c.accent,
          color: c.accentInk,
          fontWeight: 800,
          letterSpacing: '.03em',
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: c.accentInk,
            opacity: 0.7,
          }}
        />
        <span>{session.name}</span>
      </div>
      <Arrow color={c.accent} size={barH} fill={firstWindowActive ? c.titleActiveBg : undefined} />

      {/* Windows (in display order; `index` is the backend switch index, the
          array position is the shown number + prefix+digit hotkey). */}
      {orderedWindows.map(({ win: w, index }, displayIndex) => {
        const isActive = index === session.active_window;
        const winLevel = windowNotificationLevel(
          w.panes.map((p) => p.id),
          notifications,
        );
        const zoomGlyph = w.zoomed_pane ? <span style={{ color: c.zoom, marginLeft: '3px' }}>⛶</span> : null;
        const dot = winLevel ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              goToWindow(index, w.name);
            }}
            style={{
              color: notificationColor(winLevel, config?.theme ?? null),
              marginLeft: '4px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            ●
          </span>
        ) : null;

        if (isActive) {
          return (
            <div key={w.id} style={{ display: 'flex', height: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  height: '100%',
                  padding: '0 12px',
                  background: c.titleActiveBg,
                  color: c.fgBright,
                  fontWeight: 700,
                }}
              >
                <span style={{ color: c.accent }}>{displayIndex}</span>
                <span>{w.name}</span>
                <span style={{ color: c.accent }}>*</span>
                {zoomGlyph}
                {dot}
              </div>
              <Arrow color={c.titleActiveBg} size={barH} />
            </div>
          );
        }
        return (
          <div
            key={w.id}
            onClick={() => goToWindow(index, w.name)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: '100%',
              padding: '0 12px',
              color: c.fgMuted,
              cursor: 'pointer',
            }}
          >
            <span style={{ color: c.fgDim }}>{displayIndex}</span>
            <span>{w.name}</span>
            {zoomGlyph}
            {dot}
          </div>
        );
      })}

      <span style={{ flex: 1 }} />

      {/* Right cluster */}
      {prefixActive && (
        <div
          style={{
            display: 'flex',
            height: '100%',
            animation: animations ? 'btm-prefix-in .22s ease both' : undefined,
          }}
        >
          <Arrow color={c.warn} size={barH} direction="left" />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              height: '100%',
              padding: '0 12px',
              background: c.warn,
              color: c.warnInk,
              fontWeight: 800,
              letterSpacing: '.04em',
              animation: animations ? 'btm-prefix-pulse 1.5s ease-in-out .3s infinite' : undefined,
            }}
          >
            PREFIX <span style={{ opacity: 0.75, fontWeight: 700 }}>{config ? prefixLabel(config.prefix) : '⌃B'}</span>
          </div>
        </div>
      )}
      {activeZoomed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            height: '100%',
            padding: '0 13px',
            color: c.zoom,
            borderLeft: `1px solid ${c.borderDim}`,
          }}
        >
          ⛶ <span style={{ fontWeight: 700 }}>ZOOM</span>
        </div>
      )}
      <SysStatBar c={c} barH={barH} font={font} />
    </div>
  );
}
