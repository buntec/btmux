import { useCallback } from 'react';
import { useStore } from '../state/store';
import { DEFAULT_THEME } from '../state/defaultTheme';

const ANIMATION_STYLE = `
@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
`;

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const theme = useStore((s) => s.config?.theme);
  const dismissToast = useStore((s) => s.dismissToast);
  const navigateToPane = useStore((s) => s.navigateToPane);

  const handleClick = useCallback(
    (toastId: number, paneId?: string) => {
      dismissToast(toastId);
      if (paneId) navigateToPane(paneId);
    },
    [dismissToast, navigateToPane],
  );

  if (toasts.length === 0) return null;

  const bg = theme?.black ?? DEFAULT_THEME.black;
  const fg = theme?.brightWhite ?? DEFAULT_THEME.brightWhite;
  const dimFg = theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const borderInfo = theme?.yellow ?? DEFAULT_THEME.yellow;
  const borderError = theme?.red ?? DEFAULT_THEME.red;

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div
        style={{
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          pointerEvents: 'none',
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => handleClick(toast.id, toast.paneId)}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              position: 'relative',
              background: bg,
              color: fg,
              border: `1px solid ${toast.level === 'error' ? borderError : borderInfo}`,
              borderRadius: '6px',
              padding: '12px 32px 12px 14px',
              fontFamily: 'var(--btmux-font, monospace)',
              fontWeight: 'var(--btmux-font-weight, 400)',
              fontSize: '13px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              maxWidth: '400px',
              minWidth: '240px',
              animation: 'toast-slide-in 0.2s ease-out',
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(toast.id);
              }}
              style={{
                position: 'absolute',
                top: '6px',
                right: '8px',
                background: 'none',
                border: 'none',
                color: dimFg,
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: 1,
                padding: '2px 4px',
              }}
            >
              ×
            </button>
            <div style={{ fontWeight: 500 }}>{toast.message}</div>
            {toast.body && (
              <div
                style={{
                  color: dimFg,
                  fontSize: '12px',
                  marginTop: '4px',
                  whiteSpace: 'pre-wrap',
                  overflow: 'hidden',
                  maxHeight: '4.8em',
                  lineHeight: '1.4',
                }}
              >
                {toast.body}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
