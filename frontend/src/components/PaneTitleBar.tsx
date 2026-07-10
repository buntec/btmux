import { chromePalette, withAlpha } from '../lib/chrome-colors';
import type { Theme } from '../state/types';

/**
 * Height of a pane title bar for a given terminal font size. TerminalPane insets
 * its terminal container by this amount when titles are enabled, so it lives here
 * next to the bar that defines it.
 */
export function paneTitleHeight(termFont: number): number {
  const font = chromeFont(termFont);
  return Math.round(font * 2.3);
}

/** Chrome font size derived from the terminal font (compact, clamped). */
function chromeFont(termFont: number): number {
  return Math.max(10, Math.min(17, Math.round(termFont * 0.68)));
}

/** Collapse a home-directory prefix to `~` so cwds read like the shell prompt. */
function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const collapsed = cwd.replace(/^\/(?:Users|home)\/[^/]+/, '~');
  return collapsed || cwd;
}

interface Props {
  theme: Theme | null;
  index: number;
  title: string | null | undefined;
  cwd: string | null | undefined;
  cols: number | null;
  rows: number | null;
  isActive: boolean;
  /** Color of the pending-notification dot for this pane, or null if none. */
  notificationColor: string | null;
  termFont: number;
}

/**
 * The per-pane title bar from the "btmux Chrome" design: an accent stripe +
 * numbered badge, the pane title/shell, its working directory, and the live cols×rows. The active pane gets a filled accent badge and a
 * brighter fill; inactive panes get a muted badge and a status dot. Fully
 * theme-driven via `chromePalette`.
 */
export function PaneTitleBar({ theme, index, title, cwd, cols, rows, isActive, notificationColor, termFont }: Props) {
  const c = chromePalette(theme);
  const font = chromeFont(termFont);
  const height = paneTitleHeight(termFont);
  const badgeSize = Math.round(font * 1.35);
  const label = (title && title.trim()) || 'shell';
  const dir = shortCwd(cwd);

  const badge: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: `${badgeSize}px`,
    height: `${Math.round(badgeSize * 0.9)}px`,
    padding: '0 4px',
    borderRadius: '5px',
    fontSize: `${Math.max(9, font - 2)}px`,
    fontWeight: 800,
    flex: 'none',
    background: isActive ? c.accent : withAlpha(c.fgMuted, 0.22),
    color: isActive ? c.accentInk : c.fgMuted,
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: `${Math.round(font * 0.6)}px`,
        height: `${height}px`,
        flex: 'none',
        padding: isActive ? '0 10px 0 0' : '0 10px',
        background: isActive ? c.titleActiveBg : c.titleInactiveBg,
        borderBottom: `1px solid ${isActive ? c.border : c.borderDim}`,
        fontSize: `${font}px`,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {isActive && <div style={{ width: '3px', alignSelf: 'stretch', background: c.accent, flex: 'none' }} />}
      <span style={badge}>{index}</span>
      <span
        style={{
          color: isActive ? c.fgBright : c.fgMuted,
          fontWeight: isActive ? 700 : 500,
          flex: 'none',
        }}
      >
        {label}
      </span>
      {dir && (
        <span
          style={{
            color: isActive ? c.fgMuted : c.fgDim,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {dir}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {notificationColor ? (
        <span
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: notificationColor,
            boxShadow: `0 0 7px ${withAlpha(notificationColor, 0.6)}`,
            flex: 'none',
          }}
        />
      ) : !isActive ? (
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: c.fgMuted, flex: 'none' }} />
      ) : null}
      {cols && rows ? (
        <span style={{ color: c.fgDim, fontSize: `${Math.max(9, font - 1)}px`, letterSpacing: '.06em', flex: 'none' }}>
          {cols}×{rows}
        </span>
      ) : null}
    </div>
  );
}
