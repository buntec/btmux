import type { ClientConfig, SessionState } from '../state/types';
import { chromePalette, withAlpha } from '../lib/chrome-colors';
import { computeRectsAndDividers } from '../state/layout';
import { MirrorPane } from './MirrorPane';

// Thumbnails use each split's stored ratio (no live drag).
const EMPTY_RATIOS: Map<string, number> = new Map();

interface Props {
  window: SessionState['windows'][number];
  visible: boolean;
  c: ReturnType<typeof chromePalette>;
  terminalConfig?: ClientConfig | null;
  shaderId?: string | null;
  activePaneId?: string | null;
  hoveredPaneId?: string | null;
  onHoveredPaneChange?: (paneId: string | null) => void;
  onSelectPane?: (paneId: string) => void;
  animations?: boolean;
}

/** Live, read-only preview of a window's split layout. */
export function WindowThumbnail({
  window: win,
  visible,
  c,
  terminalConfig,
  shaderId,
  activePaneId = null,
  hoveredPaneId = null,
  onHoveredPaneChange,
  onSelectPane,
  animations = true,
}: Props) {
  const { rects, dividers } = computeRectsAndDividers(
    win.layout,
    { top: 0, left: 0, width: 100, height: 100 },
    EMPTY_RATIOS,
  );
  const interactive = onSelectPane !== undefined;

  return (
    <>
      {rects.map((r) => {
        const isActive = r.paneId === activePaneId;
        const isHovered = r.paneId === hoveredPaneId;
        return (
          <div
            key={r.paneId}
            onMouseEnter={onHoveredPaneChange ? () => onHoveredPaneChange(r.paneId) : undefined}
            onMouseLeave={onHoveredPaneChange ? () => onHoveredPaneChange(null) : undefined}
            onMouseDown={interactive ? (event) => event.preventDefault() : undefined}
            onClick={onSelectPane ? () => onSelectPane(r.paneId) : undefined}
            style={{
              position: 'absolute',
              top: `${r.top}%`,
              left: `${r.left}%`,
              width: `${r.width}%`,
              height: `${r.height}%`,
              padding: interactive ? '3px' : '0',
              boxSizing: 'border-box',
              cursor: interactive ? 'pointer' : undefined,
            }}
          >
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                borderRadius: interactive ? '6px' : undefined,
                border: `${isActive || isHovered ? 1.5 : 1}px solid ${
                  isHovered ? c.warn : isActive ? c.accent : c.borderDim
                }`,
                boxShadow: isHovered
                  ? `0 0 0 1px ${withAlpha(c.warn, 0.22)}, 0 0 18px ${withAlpha(c.warn, 0.14)}`
                  : isActive
                    ? `0 0 18px ${c.accentGlow}`
                    : undefined,
                background: isHovered ? withAlpha(c.warn, 0.07) : withAlpha(c.bodyBg, 0.6),
                transition: animations
                  ? 'border-color 100ms ease, box-shadow 100ms ease, background 100ms ease'
                  : undefined,
              }}
            >
              {visible && (
                <MirrorPane
                  paneId={r.paneId}
                  config={terminalConfig}
                  shaderId={shaderId}
                  animations={animations}
                  visible={visible}
                />
              )}
            </div>
          </div>
        );
      })}
      {dividers.map((d) => (
        <div
          key={d.id}
          style={
            d.orientation === 'vertical'
              ? {
                  position: 'absolute',
                  top: `${d.crossStart}%`,
                  left: `${d.position}%`,
                  transform: 'translateX(-50%)',
                  width: '1px',
                  height: `${d.crossSize}%`,
                  background: 'transparent',
                  pointerEvents: 'none',
                }
              : {
                  position: 'absolute',
                  top: `${d.position}%`,
                  left: `${d.crossStart}%`,
                  transform: 'translateY(-50%)',
                  width: `${d.crossSize}%`,
                  height: '1px',
                  background: 'transparent',
                  pointerEvents: 'none',
                }
          }
        />
      ))}
    </>
  );
}
