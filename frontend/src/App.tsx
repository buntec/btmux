import { useEffect, useRef, useState } from 'react';
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
import { ShaderWallpaper } from './components/ShaderWallpaper';
import { ConfigPage } from './components/ConfigPage';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { DEFAULT_THEME } from './state/defaultTheme';
import {
  getAnimations,
  getTerminalFontFamily,
  getTerminalFontWeight,
  getWallpaperBlur,
  getWallpaperFollowsKeyboard,
  getWallpaperFollowsMouse,
  getWallpaperOpacity,
  getWallpaperSaturate,
  getWallpaperSeed,
  getWallpaperShader,
  getWallpaperSpeed,
} from './state/configDefaults';
import { ClientMessage } from './protocol/messages';
import { useFontLoader } from './hooks/useFontLoader';
import { applyThemeVars } from './lib/apply-theme-vars';
import {
  PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC,
  PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC,
} from './lib/terminalFxShaders';
import { baseShaderSrc } from './lib/baseShader';
import { pumpRenders } from './lib/pumpRenders';

// Must match the ramp shaders' own rampSeconds constants in terminalFxShaders.ts.
const PIX_RAMP_IN_MS = 250;
const PIX_RAMP_OUT_MS = 150;

interface PaneRenderer {
  setPostProcessShader?(shader: string | null): void;
  requestRender?(): void;
}

function paneRenderers(paneIds: readonly string[]): PaneRenderer[] {
  const terminals = useStore.getState().terminals;
  return paneIds.flatMap((paneId) => {
    const renderer = terminals.get(paneId)?.renderer;
    return renderer ? [renderer] : [];
  });
}

function setRenderersPostProcess(renderers: Iterable<PaneRenderer>, shader: string | null): void {
  for (const renderer of renderers) renderer.setPostProcessShader?.(shader);
}

/**
 * Applies the WebGL pixelate post-process shader (terminalFxShaders.ts) to the
 * visible panes while the session switcher or help overlay is open — the
 * privacy-blur backdrop for those overlays. Replaces an earlier whole-stage
 * SVG CSS filter that pixelated the entire SessionPool DOM subtree in one
 * shot; this instead asks each pane's own ghostty-web WebGL context to
 * pixelate its own content. Trade-off: title bars/borders/dividers (separate
 * DOM/React elements outside any pane's WebGL context) are no longer
 * pixelated, only terminal cell content is — accepted in favor of dropping
 * the SVG filter's hackiness.
 */
function usePanePixelateOverlay(pixActive: boolean, animations: boolean, visiblePaneIds: readonly string[]): void {
  const prevActive = useRef(false);
  const visiblePaneIdsRef = useRef(visiblePaneIds);
  const affectedRenderersRef = useRef<PaneRenderer[]>([]);
  visiblePaneIdsRef.current = visiblePaneIds;

  useEffect(() => {
    if (!animations) {
      setRenderersPostProcess(affectedRenderersRef.current, baseShaderSrc());
      affectedRenderersRef.current = [];
      prevActive.current = false;
      return;
    }
    if (pixActive && !prevActive.current) {
      // Only the active window is visible behind the overlay. Hidden terminals
      // in the cross-session/window keep-alive pools are suspended and should
      // not compile or render a privacy shader they can never display.
      setRenderersPostProcess(affectedRenderersRef.current, baseShaderSrc());
      const affected = paneRenderers(visiblePaneIdsRef.current);
      affectedRenderersRef.current = affected;
      setRenderersPostProcess(affected, PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC);
      prevActive.current = pixActive;
      return pumpRenders(() => affected, PIX_RAMP_IN_MS);
    }
    if (!pixActive && prevActive.current) {
      // Restore exactly the renderers pixelated on entry. During a session
      // selection the newly-visible pane is different and owns its own switch
      // effect, while the old (now hidden) renderer still needs its base shader
      // restored before it is shown again.
      const affected = affectedRenderersRef.current;
      setRenderersPostProcess(affected, PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC);
      prevActive.current = pixActive;
      // Hand the post-process slot back to the configured persistent effect
      // (`shader = "..."`), which is null when none is set.
      return pumpRenders(
        () => affected,
        PIX_RAMP_OUT_MS,
        () => {
          setRenderersPostProcess(affected, baseShaderSrc());
          if (affectedRenderersRef.current === affected) affectedRenderersRef.current = [];
        },
      );
    }
    prevActive.current = pixActive;
  }, [pixActive, animations]);
}

/**
 * Keep decorative GPU work stopped while a route change mounts a session's
 * terminals. The changed id makes this true during the transition render, so
 * ShaderWallpaper can pause in a layout effect before TerminalPane's passive
 * mount effects synchronously create their WebGL contexts. Two animation
 * frames give those mounts and their first paint a chance to finish before the
 * wallpaper resumes; a main-thread stall naturally delays both frames.
 */
function useSessionTransitionPause(activeSessionId: string | null): boolean {
  const [settledSessionId, setSettledSessionId] = useState(activeSessionId);
  const transitioning = activeSessionId !== settledSessionId;

  useEffect(() => {
    if (!transitioning) return;

    let resumeRaf = 0;
    const settleRaf = requestAnimationFrame(() => {
      resumeRaf = requestAnimationFrame(() => setSettledSessionId(activeSessionId));
    });
    return () => {
      cancelAnimationFrame(settleRaf);
      cancelAnimationFrame(resumeRaf);
    };
  }, [activeSessionId, transitioning]);

  return transitioning;
}

function AppInner({ send }: { send: (msg: ClientMessage) => void }) {
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const overlay = useStore((s) => s.overlay);
  const navigate = useNavigate();
  const location = useLocation();
  const privacyOverlayActive = switcherOpen || overlay?.mode === 'keys';

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
  const onConfig = location.pathname === '/config';
  const activeSessionId = currentSessionName
    ? (allSessions.find((s) => s.name === currentSessionName)?.id ?? null)
    : null;
  const sessionTransitionActive = useSessionTransitionPause(activeSessionId);
  const activeSession = activeSessionId ? allSessions.find((session) => session.id === activeSessionId) : null;
  const activeWindow = activeSession?.windows[activeSession.active_window];
  const visiblePaneIds = activeWindow?.zoomed_pane
    ? [activeWindow.zoomed_pane]
    : (activeWindow?.panes.map((pane) => pane.id) ?? []);

  // Privacy-pixelate only the panes actually visible behind the switcher/help.
  usePanePixelateOverlay(privacyOverlayActive, getAnimations(config), visiblePaneIds);

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
  // Preserve an explicitly disabled shader (`null`) after config loads while
  // still showing the built-in default during the initial connection.
  const wallpaperShader = getWallpaperShader(config);
  const wallpaperOpacity = getWallpaperOpacity(config);
  const wallpaperBlur = getWallpaperBlur(config);
  const wallpaperSaturate = getWallpaperSaturate(config);
  const wallpaperSpeed = getWallpaperSpeed(config);
  const wallpaperSeed = getWallpaperSeed(config);
  const wallpaperFollowsMouse = getWallpaperFollowsMouse(config);
  const wallpaperFollowsKeyboard = getWallpaperFollowsKeyboard(config);

  // Layout: a flex column owning the viewport. The pane region (flex:1) holds the
  // persistent SessionPool underneath, the route content (LandingPage or the
  // effects-only SessionView) on top, and a single Overlay. StatusBar sits below.
  // Flexbox gives the region exactly "viewport minus status bar" — the same shape
  // SessionView used to own, hoisted up one level so it survives navigation and
  // the keep-alive pool persists across session switches.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {!onConfig &&
        (wallpaperShader ? (
          <ShaderWallpaper
            shaderId={wallpaperShader}
            opacity={wallpaperOpacity}
            blur={wallpaperBlur}
            saturate={wallpaperSaturate}
            speed={wallpaperSpeed}
            animated={getAnimations(config) && wallpaperSpeed > 0}
            // Modal animations and first-time session mounts both compete with
            // the wallpaper for GPU time. Keep it stopped until that foreground
            // work has completed and the newly-visible terminals have painted.
            paused={privacyOverlayActive || sessionTransitionActive}
            seed={wallpaperSeed}
            followsMouseCursor={wallpaperFollowsMouse}
            followsKeyboardInput={wallpaperFollowsKeyboard}
          />
        ) : wallpaper ? (
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
        ) : null)}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <SessionPool send={send} />
        <Routes>
          <Route path="/" element={<LandingPage send={send} currentSessionId={currentSessionId} />} />
          <Route path="/config" element={config ? <ConfigPage config={config} send={send} /> : null} />
          <Route path="/s/:sessionName" element={<SessionView send={send} />} />
          <Route path="/s/:sessionName/w/:windowName" element={<SessionView send={send} />} />
        </Routes>
        {/* Single Overlay for both landing and session views. On landing,
            activeSessionId is null, so anchor to the last-visited session (its
            prompts — rename/new — target that session; new-session ignores it). */}
        {!onConfig && (
          <Overlay
            sessionId={activeSessionId ?? currentSessionId ?? allSessions[0]?.id ?? ''}
            send={send}
            config={config}
          />
        )}
        {/* Live window-grid thumbnails (prefix + w). Sits above the pane region
            like the Overlay; mounts lazily on first open and stays warm. */}
        {!onConfig && <WindowGrid send={send} />}
        {/* Session/window switcher modal (prefix + s). Also above the pane region;
            lazily mounted on first open and kept warm like the grid. */}
        {!onConfig && <SessionSwitcher send={send} />}
      </div>
      {/* No status bar on the landing page (it has its own full-height chrome). */}
      {!onLanding && !onConfig && <StatusBar sessionId={activeSessionId ?? ''} send={send} />}
    </div>
  );
}

export function App() {
  const { send } = useControlSocket();
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  useFontLoader();

  useEffect(() => {
    const family = getTerminalFontFamily(config);
    const weight = String(getTerminalFontWeight(config));
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
          fontFamily: 'var(--btmux-font)',
          fontWeight: 'var(--btmux-font-weight)',
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
      <TooltipProvider>
        <ConnectionBanner />
        <Toaster position="top-right" />
        <AppInner send={send} />
      </TooltipProvider>
    </BrowserRouter>
  );
}
