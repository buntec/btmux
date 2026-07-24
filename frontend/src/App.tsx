import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useStore } from './state/store';
import { useControlSocket } from './hooks/useControlSocket';
import { LandingPage, recordMruVisit } from './components/LandingPage';
import { SessionView } from './components/SessionView';
import { SessionPool } from './components/SessionPool';
import { StatusBar } from './components/StatusBar';
import { Overlay } from './components/Overlay';
import { WindowGrid } from './components/WindowGrid';
import { SessionSwitcher } from './components/SessionSwitcher';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toaster } from './components/ui/sonner';
import { DEFAULT_THEME } from './state/defaultTheme';
import { ClientMessage } from './protocol/messages';
import { useFontLoader, DEFAULT_FONT_FAMILY, DEFAULT_FONT_WEIGHT } from './hooks/useFontLoader';
import { applyThemeVars } from './lib/apply-theme-vars';
import {
  PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC,
  PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC,
} from './lib/terminalFxShaders';

// Must match the ramp shaders' own rampSeconds constants in terminalFxShaders.ts.
const PIX_RAMP_IN_MS = 250;
const PIX_RAMP_OUT_MS = 150;

function setPanesPostProcess(shader: string | null): void {
  for (const term of useStore.getState().terminals.values()) {
    term.renderer?.setPostProcessShader?.(shader);
  }
}

// ghostty-web only repaints on its own event-driven wake points (PTY writes,
// cursor blink, etc.) — an idle terminal wouldn't otherwise animate a
// u_time-driven post-process shader like our pixelate ramps, so we have to
// keep asking every pane to render for the ramp's duration. Returns a cancel
// function, usable directly as a useEffect cleanup.
function pumpPaneRenders(durationMs: number, onDone?: () => void): () => void {
  let rafId = 0;
  const start = performance.now();
  const tick = () => {
    for (const term of useStore.getState().terminals.values()) {
      term.renderer?.requestRender?.();
    }
    if (performance.now() - start < durationMs) {
      rafId = requestAnimationFrame(tick);
    } else {
      onDone?.();
    }
  };
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}

/**
 * Applies the WebGL pixelate post-process shader (terminalFxShaders.ts) to
 * every mounted pane while the session switcher or help overlay is open —
 * the privacy-blur backdrop for those overlays. Replaces an earlier whole-stage
 * SVG CSS filter that pixelated the entire SessionPool DOM subtree in one
 * shot; this instead asks each pane's own ghostty-web WebGL context to
 * pixelate its own content. Trade-off: title bars/borders/dividers (separate
 * DOM/React elements outside any pane's WebGL context) are no longer
 * pixelated, only terminal cell content is — accepted in favor of dropping
 * the SVG filter's hackiness.
 */
function usePanePixelateOverlay(pixActive: boolean, animations: boolean): void {
  const prevActive = useRef(false);

  useEffect(() => {
    if (!animations) {
      setPanesPostProcess(null);
      prevActive.current = false;
      return;
    }
    if (pixActive && !prevActive.current) {
      setPanesPostProcess(PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC);
      prevActive.current = pixActive;
      return pumpPaneRenders(PIX_RAMP_IN_MS);
    }
    if (!pixActive && prevActive.current) {
      setPanesPostProcess(PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC);
      prevActive.current = pixActive;
      return pumpPaneRenders(PIX_RAMP_OUT_MS, () => setPanesPostProcess(null));
    }
    prevActive.current = pixActive;
  }, [pixActive, animations]);
}

function AppInner({ send }: { send: (msg: ClientMessage) => void }) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const overlay = useStore((s) => s.overlay);
  const navigate = useNavigate();
  const location = useLocation();

  // Privacy-pixelate every pane while the session switcher or help overlay is open.
  usePanePixelateOverlay(switcherOpen || overlay?.mode === 'keys', config?.animations ?? true);

  // Expose the router's navigate to code outside <BrowserRouter> (the control
  // socket's OS-notification onclick) so clicking a notification jumps to the pane.
  const setNavigateFn = useStore((s) => s.setNavigateFn);
  useEffect(() => {
    setNavigateFn((path) => navigate(path));
  }, [navigate, setNavigateFn]);

  // On cold load at /, auto-redirect to the last known session for this tab.
  // If sessionStorage already has a last-session entry, the user has visited a
  // session in this tab before — a navigation back to / is intentional (show
  // the landing page). Only redirect when the tab is brand-new.
  const didAutoRedirect = useRef(false);
  useEffect(() => {
    if (allSessions.length === 0) return;
    if (location.pathname !== '/') return;
    if (didAutoRedirect.current) return;
    didAutoRedirect.current = true;

    // If this tab already visited a session, honour the / navigation (landing page).
    if (sessionStorage.getItem('btmux-last-session')) return;

    const target = allSessions[0];
    if (target) {
      const activeWin = target.windows[target.active_window];
      const url = activeWin
        ? `/s/${encodeURIComponent(target.name)}/w/${encodeURIComponent(activeWin.name)}`
        : `/s/${encodeURIComponent(target.name)}`;
      navigate(url, { replace: true });
    }
  }, [allSessions.length, location.pathname, navigate]);

  // Track current session name for the landing page (so it can highlight the active session)
  const currentSessionNameMatch = location.pathname.match(/^\/s\/([^/]+)/);
  const currentSessionName = currentSessionNameMatch ? decodeURIComponent(currentSessionNameMatch[1]) : null;
  const lastSessionName = currentSessionName ?? sessionStorage.getItem('btmux-last-session');
  const currentSessionId = allSessions.find((s) => s.name === lastSessionName)?.id ?? null;

  // The session shown right now, derived purely from the URL (null on landing).
  // Distinct from currentSessionId, which falls back to the last-visited session
  // so the landing page can still highlight/anchor to it. SessionPool derives the
  // same active id independently from useLocation.
  const onLanding = location.pathname === '/';
  const activeSessionId = currentSessionName
    ? (allSessions.find((s) => s.name === currentSessionName)?.id ?? null)
    : null;

  // Remember current session per tab (stored as name), and keep the
  // previously-active session name so `prefix + L` (last-session) can toggle
  // back to it — mirroring tmux's `switch-client -l`.
  useEffect(() => {
    if (currentSessionName) {
      const prevCurrent = sessionStorage.getItem('btmux-last-session');
      if (prevCurrent && prevCurrent !== currentSessionName) {
        sessionStorage.setItem('btmux-prev-session', prevCurrent);
      }
      sessionStorage.setItem('btmux-last-session', currentSessionName);
    }
  }, [currentSessionName]);

  // Record MRU visit whenever the active session changes.
  useEffect(() => {
    if (activeSessionId) recordMruVisit(activeSessionId);
  }, [activeSessionId]);

  const wallpaper = config?.wallpaper ?? null;
  const wallpaperOpacity = config?.wallpaper_opacity ?? 1;
  const wallpaperBlur = config?.wallpaper_blur ?? 0;
  const wallpaperSaturate = config?.wallpaper_saturate ?? 1;

  // Layout: a flex column owning the viewport. The pane region (flex:1) holds the
  // persistent SessionPool underneath, the route content (LandingPage or the
  // effects-only SessionView) on top, and a single Overlay. StatusBar sits below.
  // Flexbox gives the region exactly "viewport minus status bar" — the same shape
  // SessionView used to own, hoisted up one level so it survives navigation and
  // the keep-alive pool persists across session switches.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {wallpaper && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundImage: `url(${wallpaper})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: wallpaperOpacity,
            filter: `blur(${wallpaperBlur}px) saturate(${wallpaperSaturate})`,
            zIndex: -1,
            pointerEvents: 'none',
          }}
        />
      )}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <SessionPool send={send} />
        <Routes>
          <Route path="/" element={<LandingPage send={send} currentSessionId={currentSessionId} />} />
          <Route path="/s/:sessionName" element={<SessionView send={send} />} />
          <Route path="/s/:sessionName/w/:windowName" element={<SessionView send={send} />} />
        </Routes>
        {/* Single Overlay for both landing and session views. On landing,
            activeSessionId is null, so anchor to the last-visited session (its
            prompts — rename/new — target that session; new-session ignores it). */}
        <Overlay
          sessionId={activeSessionId ?? currentSessionId ?? allSessions[0]?.id ?? ''}
          send={send}
          config={config}
        />
        {/* Live window-grid thumbnails (prefix + w). Sits above the pane region
            like the Overlay; mounts lazily on first open and stays warm. */}
        <WindowGrid send={send} />
        {/* Session/window switcher modal (prefix + s). Also above the pane region;
            lazily mounted on first open and kept warm like the grid. */}
        <SessionSwitcher send={send} />
      </div>
      {/* No status bar on the landing page (it has its own full-height chrome). */}
      {!onLanding && <StatusBar sessionId={activeSessionId ?? ''} send={send} />}
    </div>
  );
}

export function App() {
  const { send } = useControlSocket();
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  useFontLoader();

  useEffect(() => {
    const family = config?.terminal?.fontFamily ?? DEFAULT_FONT_FAMILY;
    const weight = String(config?.terminal?.fontWeight ?? DEFAULT_FONT_WEIGHT);
    document.documentElement.style.setProperty('--btmux-font', `"${family}", monospace`);
    document.documentElement.style.setProperty('--btmux-font-weight', weight);
  }, [config?.terminal?.fontFamily, config?.terminal?.fontWeight]);

  useEffect(() => {
    document.body.style.background = config?.theme?.background ?? DEFAULT_THEME.background;
    applyThemeVars(config?.theme ?? DEFAULT_THEME);
  }, [config?.theme]);

  if (allSessions.length === 0 || !config) {
    const cached = (() => {
      try {
        const s = localStorage.getItem('btmux-theme');
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    })();
    const bg = cached?.background ?? DEFAULT_THEME.background;
    const fg = cached?.brightBlack ?? DEFAULT_THEME.brightBlack;
    const accent = cached?.cyan ?? DEFAULT_THEME.cyan;
    return (
      <div
        style={{
          background: bg,
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: fg,
          fontFamily: 'var(--btmux-font, monospace)',
          fontWeight: 'var(--btmux-font-weight, 400)',
          fontSize: '13px',
        }}
      >
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }
        `}</style>
        <span style={{ animation: 'pulse 2s ease-in-out infinite', color: accent }}>connecting…</span>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <ConnectionBanner />
      <Toaster position="top-right" />
      <AppInner send={send} />
    </BrowserRouter>
  );
}
