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
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toaster } from './components/ui/sonner';
import { DEFAULT_THEME } from './state/defaultTheme';
import { ClientMessage } from './protocol/messages';
import { useFontLoader } from './hooks/useFontLoader';
import { applyThemeVars } from './lib/apply-theme-vars';

function AppInner({ send }: { send: (msg: ClientMessage) => void }) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const navigate = useNavigate();
  const location = useLocation();

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
      </div>
      {/* No status bar on the landing page (it has its own full-height chrome). */}
      {!onLanding && <StatusBar sessionId={activeSessionId ?? ''} />}
    </div>
  );
}

export function App() {
  const { send } = useControlSocket();
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  useFontLoader();

  useEffect(() => {
    const family = config?.terminal?.fontFamily ?? 'JetBrains Mono';
    const weight = String(config?.terminal?.fontWeight ?? 400);
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
      <Toaster position="top-right" closeButton />
      <AppInner send={send} />
    </BrowserRouter>
  );
}
