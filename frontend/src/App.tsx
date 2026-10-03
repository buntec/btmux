import { Spinner } from '@astryxdesign/core/Spinner';
import { Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';
import { WorkspaceShell } from './components/WorkspaceShell';
import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useStore } from './state/store';
import { useControlSocket } from './hooks/useControlSocket';
import { getSessionMruOrder, recordSessionMruVisit } from './state/sessionMru';
import { SessionView } from './components/SessionView';
import { SessionPool } from './components/SessionPool';
import { StatusBar } from './components/StatusBar';
import { Overlay } from './components/Overlay';
import { WindowGrid } from './components/WindowGrid';
import { AgentGrid } from './components/AgentGrid';
import { SessionSwitcher } from './components/SessionSwitcher';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ShaderWallpaper } from './components/ShaderWallpaper';
import { ConfigPage } from './components/ConfigPage';
import { NotificationToasts } from './components/NotificationToasts';
import { DEFAULT_THEME } from './state/defaultTheme';
import { STARTUP_THEME } from './state/startupTheme';
import {
  getAnimations,
  getDesktopBackgroundOpacity,
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
import {
  PIXELATE_RAMP_IN_POSTPROCESS_FRAGMENT_SRC,
  PIXELATE_RAMP_OUT_POSTPROCESS_FRAGMENT_SRC,
  findShaderEffect,
} from './lib/terminalFxShaders';
import { baseShaderSrc } from './lib/baseShader';
import { pumpRenders } from './lib/pumpRenders';
import { pageBackground } from './lib/desktopTransparency';

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
 * visible panes while the help overlay is open — its privacy backdrop.
 * Replaces an earlier whole-stage
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
      // Hand the post-process slot back to the session-switcher effect when
      // that modal is still open, otherwise to the persistent terminal effect.
      return pumpRenders(
        () => affected,
        PIX_RAMP_OUT_MS,
        () => {
          const state = useStore.getState();
          const restored = state.switcherOpen
            ? (findShaderEffect(state.config?.session_view_shader)?.src ?? baseShaderSrc())
            : baseShaderSrc();
          setRenderersPostProcess(affected, restored);
          if (affectedRenderersRef.current === affected) affectedRenderersRef.current = [];
        },
      );
    }
    prevActive.current = pixActive;
  }, [pixActive, animations]);
}

/** Temporarily replaces the visible panes' base shader while `prefix + s` is open. */
function useSessionViewShader(
  active: boolean,
  shaderId: string | null | undefined,
  animations: boolean,
  visiblePaneIds: readonly string[],
): void {
  const visiblePaneIdsRef = useRef(visiblePaneIds);
  visiblePaneIdsRef.current = visiblePaneIds;
  const effect = findShaderEffect(shaderId);

  useEffect(() => {
    if (!active || !effect) return;

    const affected = paneRenderers(visiblePaneIdsRef.current);
    setRenderersPostProcess(affected, effect.src);
    for (const renderer of affected) renderer.requestRender?.();
    const stopPump = effect.animated && animations ? pumpRenders(() => affected, Infinity) : undefined;

    return () => {
      stopPump?.();
      setRenderersPostProcess(affected, baseShaderSrc());
      for (const renderer of affected) renderer.requestRender?.();
    };
  }, [active, effect?.src, effect?.animated, animations]);
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
  const configPreview = useStore((s) => s.configPreview);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const overlay = useStore((s) => s.overlay);
  const navigate = useNavigate();
  const location = useLocation();
  const helpOverlayActive = overlay?.mode === 'keys';
  const modalOverlayActive = switcherOpen || helpOverlayActive;

  // Expose the router's navigate to code outside <BrowserRouter> (the control
  // socket's OS-notification onclick) so clicking a notification jumps to the pane.
  const setNavigateFn = useStore((s) => s.setNavigateFn);
  const setControlSendFn = useStore((s) => s.setControlSendFn);
  useEffect(() => {
    setNavigateFn((path) => navigate(path));
    setControlSendFn(send);
    return () => {
      setNavigateFn(null);
      setControlSendFn(null);
    };
  }, [navigate, send, setNavigateFn, setControlSendFn]);

  // / has no view of its own: open this tab's last session, else the most recently used one.
  useEffect(() => {
    if (location.pathname !== '/' || allSessions.length === 0) return;
    const byName = (name: string | null) => allSessions.find((s) => s.name === name);
    const target =
      byName(sessionStorage.getItem('btmux-last-session')) ??
      byName(sessionStorage.getItem('btmux-prev-session')) ??
      getSessionMruOrder()
        .map((id) => allSessions.find((s) => s.id === id))
        .find((s) => s != null) ??
      allSessions[0];
    const activeWin = target.windows[target.active_window];
    const url = activeWin
      ? `/s/${encodeURIComponent(target.name)}/w/${encodeURIComponent(activeWin.name)}`
      : `/s/${encodeURIComponent(target.name)}`;
    navigate(url, { replace: true });
  }, [allSessions, location.pathname, navigate]);

  const currentSessionNameMatch = location.pathname.match(/^\/s\/([^/]+)/);
  const currentSessionName = currentSessionNameMatch ? decodeURIComponent(currentSessionNameMatch[1]) : null;
  const lastSessionName = currentSessionName ?? sessionStorage.getItem('btmux-last-session');
  const currentSessionId = allSessions.find((s) => s.name === lastSessionName)?.id ?? null;

  // The session shown right now is derived from the URL. Settings is an
  // in-place overlay, so opening it never changes the session route.
  const activeSessionId = currentSessionName
    ? (allSessions.find((s) => s.name === currentSessionName)?.id ?? null)
    : null;
  const sessionTransitionActive = useSessionTransitionPause(activeSessionId);
  const activeSession = activeSessionId ? allSessions.find((session) => session.id === activeSessionId) : null;
  const activeWindow = activeSession?.windows[activeSession.active_window];
  const visiblePaneIds = activeWindow?.zoomed_pane
    ? [activeWindow.zoomed_pane]
    : (activeWindow?.panes.map((pane) => pane.id) ?? []);

  // Apply transient shaders only to panes actually visible behind each modal.
  useSessionViewShader(
    switcherOpen && !helpOverlayActive && !settingsOpen,
    config?.session_view_shader,
    getAnimations(config),
    visiblePaneIds,
  );
  usePanePixelateOverlay(helpOverlayActive && !settingsOpen, getAnimations(config), visiblePaneIds);

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
    if (activeSessionId) recordSessionMruVisit(activeSessionId);
  }, [activeSessionId]);

  const effectiveConfig = settingsOpen ? (configPreview ?? config) : config;
  const wallpaper = effectiveConfig?.wallpaper ?? null;
  // Preserve an explicitly disabled shader (`null`) after config loads while
  // still showing the built-in default during the initial connection.
  const wallpaperShader = getWallpaperShader(effectiveConfig);
  const wallpaperOpacity = getWallpaperOpacity(effectiveConfig);
  const wallpaperBlur = getWallpaperBlur(effectiveConfig);
  const wallpaperSaturate = getWallpaperSaturate(effectiveConfig);
  const wallpaperSpeed = getWallpaperSpeed(effectiveConfig);
  const wallpaperSeed = getWallpaperSeed(effectiveConfig);
  const wallpaperFollowsMouse = getWallpaperFollowsMouse(effectiveConfig);
  const wallpaperFollowsKeyboard = getWallpaperFollowsKeyboard(effectiveConfig);

  // Layout: a flex column owning the viewport. The pane region (flex:1) holds the
  // persistent SessionPool underneath, route content or an in-place settings
  // overlay on top, and the other modal surfaces. StatusBar sits below.
  // Flexbox gives the region exactly "viewport minus status bar" — the same shape
  // SessionView used to own, hoisted up one level so it survives navigation and
  // the keep-alive pool persists across session switches.
  return (
    <WorkspaceShell send={send}>
      {wallpaperShader ? (
        <ShaderWallpaper
          shaderId={wallpaperShader}
          opacity={wallpaperOpacity}
          blur={wallpaperBlur}
          saturate={wallpaperSaturate}
          speed={wallpaperSpeed}
          animated={getAnimations(effectiveConfig) && wallpaperSpeed > 0}
          // Modal animations and first-time session mounts both compete with
          // the wallpaper for GPU time. Keep it stopped until that foreground
          // work has completed and the newly-visible terminals have painted.
          paused={modalOverlayActive || sessionTransitionActive}
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
      ) : null}
      <Layout
        content={
          <LayoutContent isScrollable={false} padding={0} className="relative min-h-0 overflow-hidden">
            <SessionPool send={send} />
            <Routes>
              <Route path="/" element={null} />
              <Route path="/s/:sessionName" element={<SessionView send={send} />} />
              <Route path="/s/:sessionName/w/:windowName" element={<SessionView send={send} />} />
            </Routes>
            {settingsOpen && config && <ConfigPage config={config} send={send} />}
            {/* Single Overlay. While / redirects, activeSessionId is null, so
            anchor to the last-visited session. */}
            {!settingsOpen && (
              <Overlay
                sessionId={activeSessionId ?? currentSessionId ?? allSessions[0]?.id ?? ''}
                send={send}
                config={config}
              />
            )}
            {/* Live window-grid thumbnails (prefix + w). Sits above the pane region
            like the Overlay; mounts lazily on first open and stays warm. */}
            {!settingsOpen && <WindowGrid send={send} />}
            {!settingsOpen && <AgentGrid send={send} />}
            {/* Session/window switcher modal (prefix + s). Also above the pane region;
            lazily mounted on first open and kept warm like the grid. */}
            {!settingsOpen && <SessionSwitcher send={send} />}
          </LayoutContent>
        }
        footer={
          activeSessionId ? (
            <LayoutFooter padding={0} hasDivider>
              <StatusBar sessionId={activeSessionId ?? ''} send={send} />
            </LayoutFooter>
          ) : undefined
        }
      />
    </WorkspaceShell>
  );
}

export function App() {
  const { send } = useControlSocket();
  const allSessions = useStore((s) => s.allSessions);
  const config = useStore((s) => s.config);
  const configPreview = useStore((s) => s.configPreview);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const effectiveConfig = settingsOpen ? (configPreview ?? config) : config;
  useFontLoader();

  useEffect(() => {
    const family = getTerminalFontFamily(effectiveConfig);
    const weight = String(getTerminalFontWeight(effectiveConfig));
    document.documentElement.style.setProperty('--btmux-font', `"${family}", monospace`);
    document.documentElement.style.setProperty('--btmux-font-weight', weight);
  }, [effectiveConfig?.terminal?.fontFamily, effectiveConfig?.terminal?.fontWeight]);

  useEffect(() => {
    document.body.style.background = pageBackground(
      effectiveConfig ? (effectiveConfig.theme?.background ?? DEFAULT_THEME.background) : STARTUP_THEME.background,
      getDesktopBackgroundOpacity(effectiveConfig),
    );
  }, [effectiveConfig?.theme, effectiveConfig?.desktop_background_opacity]);

  if (allSessions.length === 0 || !config) {
    return (
      <VStack hAlign="center" vAlign="center" className="h-full bg-body">
        <Spinner label="Connecting to btmux" />
      </VStack>
    );
  }

  return (
    <BrowserRouter>
      <ConnectionBanner />
      <NotificationToasts />
      <AppInner send={send} />
    </BrowserRouter>
  );
}
