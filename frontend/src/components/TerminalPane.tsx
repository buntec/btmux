import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Terminal, FitAddon } from 'ghostty-web';
import { useStore } from '../state/store';
import { AgentStatus, LayoutRect, ClientConfig } from '../state/types';
import { ClientMessage, NotificationLevel } from '../protocol/messages';
import { DEFAULT_THEME } from '../state/defaultTheme';
import { AgentStatusBadge, PaneTitleBar } from './PaneTitleBar';
import { mix, withAlpha } from '../lib/chrome-colors';
import { findPaneSwitchEffect, findShaderEffect } from '../lib/terminalFxShaders';
import { findPaneBorderStyle } from '../lib/paneSwitchBorder';
import { baseShaderSrc } from '../lib/baseShader';
import { pumpRenders } from '../lib/pumpRenders';
import { announceWallpaperKeyboardCursor } from '../lib/wallpaperInteraction';
import {
  CONFIG_DEFAULTS,
  getAnimations,
  getPaneSwitchBorderSpeed,
  getPaneSwitchBorderStyle,
  getPaneSwitchDuration,
  getPaneSwitchIntensity,
  getShowPaneTitles,
  getTerminalFontFamily,
  getTerminalFontSize,
  getTerminalFontWeight,
} from '../state/configDefaults';

interface Props {
  sessionId: string;
  paneId: string;
  rect: LayoutRect;
  isActive: boolean;
  /** Pane title (OSC 0/2), shown in the title bar. */
  title?: string | null;
  /** Pane working directory (OSC 7), shown in the title bar. */
  cwd?: string | null;
  /** Server-authoritative semantic status for an agent in this pane. */
  agentStatus?: AgentStatus;
  /** 0-based pane index within its window (layout order), shown as the badge. */
  paneIndex?: number;
  /**
   * Whether this pane is shown right now — i.e. it's in the active window of the
   * active session. Panes of inactive windows (or of pooled-but-inactive
   * sessions) stay mounted (the keep-alive pool) but are hidden with
   * `display:none` and `suspend()`ed so switches don't tear down and rebuild
   * ghostty-web instances. See SessionPane for the pool rationale.
   */
  visible: boolean;
  /** True when this pane is the sole, fullscreen-zoomed pane of its window. */
  isZoomed?: boolean;
  /**
   * Shared paneId→Terminal map owned by SessionPane. The pane registers its
   * Terminal here so SessionPane can authoritatively focus the active pane after
   * a window switch (see the focus race note in SessionPane).
   */
  registry?: Map<string, Terminal>;
  send: (msg: ClientMessage) => void;
}

const FONT_FALLBACK = 'Symbols Nerd Font Mono, Menlo, Monaco, monospace';
// ghostty-web's `scrollback` option feeds the WASM core's `max_scrollback`,
// which is a BYTE budget (see the conversion in buildTerminalOptions). This is
// the assumed average bytes-per-line used to turn the configured line count
// into that budget; upstream Ghostty defaults to ~1 KB/line (10 MB / 10000).
const SCROLLBACK_BYTES_PER_LINE = 1000;

function buildFontFamily(configured: string): string {
  return `${configured}, ${FONT_FALLBACK}`;
}

export function buildTerminalOptions(config: ClientConfig | null): ConstructorParameters<typeof Terminal>[0] | null {
  if (!config) return null;
  const t = config.terminal;
  const opts: ConstructorParameters<typeof Terminal>[0] = {
    fontSize: getTerminalFontSize(config),
    fontFamily: buildFontFamily(getTerminalFontFamily(config)),
    theme: config?.theme ?? DEFAULT_THEME,
    cursorBlink: t?.cursorBlink ?? CONFIG_DEFAULTS.terminal.cursorBlink,
  };
  // Experimental WebGL backend (ghostty-web fork); falls back to Canvas2D if
  // WebGL2 init fails. Omitted when unset so ghostty-web's canvas default applies.
  if (t?.renderer != null) opts.renderer = t.renderer;
  if (t?.cursorStyle != null) opts.cursorStyle = t.cursorStyle;
  // ghostty-web's `scrollback` option is documented (and configured here) as a
  // LINE count, but it's written verbatim into the WASM core's `max_scrollback`
  // field, which Ghostty interprets in BYTES. Passing `10000` therefore yields
  // only ~10 KB of scrollback (~800 lines of plain text). Convert the configured
  // line count into a byte budget so the emulator retains roughly the requested
  // number of lines even for wide/colored output (10000 lines → 10 MB, matching
  // upstream Ghostty's default).
  if (t?.scrollback != null) opts.scrollback = t.scrollback * SCROLLBACK_BYTES_PER_LINE;
  // When a wallpaper is configured, enable transparency so it shows through
  // the terminal background; explicit allow-transparency still wins.
  const hasWallpaper = config?.wallpaper != null || config?.wallpaper_shader != null;
  const allowTransparency = t?.allowTransparency ?? (hasWallpaper ? true : null);
  if (allowTransparency != null) opts.allowTransparency = allowTransparency;
  if (t?.convertEol != null) opts.convertEol = t.convertEol;
  if (t?.disableStdin != null) opts.disableStdin = t.disableStdin;
  if (t?.smoothScrollDuration != null) opts.smoothScrollDuration = t.smoothScrollDuration;
  // Non-upstream option consumed by our ghostty-web patch (see patches/).
  if (t?.scrollSensitivity != null) opts.scrollSensitivity = t.scrollSensitivity;
  if (t?.fontWeight != null) opts.fontWeight = t.fontWeight;
  return opts;
}

// Key only the options that require a new emulator. Theme and shader updates
// have their own effects and must not reconnect all pooled panes.
export function useTerminalOptions(config: ClientConfig | null) {
  const options = buildTerminalOptions(config);
  const key = JSON.stringify(options ? { ...options, theme: undefined } : null);
  return useMemo(() => JSON.parse(key) as ReturnType<typeof buildTerminalOptions>, [key]);
}

export function TerminalPane({
  sessionId,
  paneId,
  rect,
  isActive,
  title,
  cwd,
  agentStatus,
  paneIndex,
  visible,
  isZoomed = false,
  registry,
  send,
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Live terminal dimensions, shown as "cols×rows" in the title bar. Updated from
  // the fit/resize path so the bar tracks the pane's real grid.
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  // Read inside the ResizeObserver/rAF closures so they always see the current
  // visibility without re-running the mount effect (which would dispose+rebuild
  // the terminal). A hidden pane has a 0-size container, so it must neither fit
  // nor open its socket — doing so would size the PTY to garbage.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const config = useStore((s) => s.config);
  const overlay = useStore((s) => s.overlay);
  const windowGridOpen = useStore((s) => s.windowGridOpen);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const fileBrowserOpen = useStore((s) => s.fileBrowserOpen && s.fileBrowserPaneId === paneId);
  const termOptions = useTerminalOptions(config);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  // Keep a newly-created emulator hidden while the server streams its initial
  // checkpoint + journal. Parsing writes is synchronous, but paints happen on
  // animation frames; revealing only after the frame queued by `ready` avoids
  // showing a long replay as rapidly scrolling terminal output.
  const [initialReplayRendered, setInitialReplayRendered] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !termOptions) return;
    setConnection('connecting');
    setInitialReplayRendered(false);

    const term = new Terminal(termOptions);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    // ghostty-web's open() auto-focuses (and schedules a deferred setTimeout(0)
    // focus); undo both if another surface owns the keyboard. This also covers a
    // terminal mounted by a server state update while the session switcher or
    // window grid is open.
    const shouldBlurOnOpen = () => {
      const s = useStore.getState();
      return !!s.overlay || s.windowGridOpen || s.switcherOpen || (s.fileBrowserOpen && s.fileBrowserPaneId === paneId);
    };
    if (shouldBlurOnOpen()) {
      term.blur();
      setTimeout(() => {
        if (shouldBlurOnOpen()) term.blur();
      }, 0);
    }

    // Explicitly load the configured font at the requested weight so the browser
    // fetches the woff2 before we measure/rasterize. Without this, Canvas2D
    // measureText doesn't trigger @font-face downloads — the font only loads when
    // DOM text is rendered, causing the first Terminal to use a fallback/synthesized
    // weight until a config change forces a rebuild.
    let fontAbort = false;
    const weight = termOptions.fontWeight ?? CONFIG_DEFAULTS.terminal.fontWeight;
    const boldWeight = Math.min(weight + 200, 900);
    const size = termOptions.fontSize!;
    const family = termOptions.fontFamily!;
    const primaryFamily = family
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    Promise.all([
      document.fonts.load(`${weight} ${size}px "${primaryFamily}"`),
      document.fonts.load(`${boldWeight} ${size}px "${primaryFamily}"`),
    ]).then(() => {
      if (fontAbort) return;
      term.remeasureFont();
      if (visibleRef.current) fitAddon.fit();
    });

    // Replace ghostty-web's built-in wheel handler for alt-screen applications
    // (e.g. Claude Code) and mouse-tracking-enabled apps. The built-in handler
    // fires raw arrow keys for alt-screen mode — one WheelEvent can emit up to
    // 5 arrows, and trackpads fire many events per gesture, making scrolling
    // uncontrollably fast. We accumulate pixel delta and emit exactly one scroll
    // action per cell-height of travel, normalizing trackpad and mouse-wheel to
    // the same rate.
    //
    // Decision tree:
    //   • alt screen + mouse tracking → SGR mouse scroll sequences (most precise)
    //   • alt screen + no tracking   → arrow keys, but accumulator-throttled
    //   • normal screen              → return false; ghostty-web scrolls viewport
    let scrollAccumPx = 0;
    term.attachCustomWheelEventHandler((event: WheelEvent) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return false;

      const hasMouseTracking = term.hasMouseTracking();
      // Mode 1049 is the DEC private mode used by Ink.js/ncurses/etc. to
      // switch to the alternate screen buffer.
      const isAltScreen = term.getMode(1049, false);

      if (!hasMouseTracking && !isAltScreen) return false; // let ghostty-web scroll viewport

      const rect = container.getBoundingClientRect();
      const lineHeight = rect.height / term.rows;

      // Normalize deltaY to pixels regardless of deltaMode.
      let deltaPx: number;
      if (event.deltaMode === 0 /* DOM_DELTA_PIXEL */) {
        deltaPx = event.deltaY;
      } else if (event.deltaMode === 1 /* DOM_DELTA_LINE */) {
        deltaPx = event.deltaY * lineHeight;
      } else /* DOM_DELTA_PAGE */ {
        deltaPx = event.deltaY * rect.height;
      }

      scrollAccumPx += deltaPx;
      const ticks = Math.trunc(scrollAccumPx / lineHeight);
      if (ticks === 0) return true; // consumed the event, wait for more travel
      scrollAccumPx -= ticks * lineHeight;

      if (hasMouseTracking) {
        // Send SGR (or X10) mouse scroll sequences. button 64 = up, 65 = down.
        const button = ticks > 0 ? 65 : 64;
        const col = Math.max(
          1,
          Math.min(term.cols, Math.floor((event.clientX - rect.left) / (rect.width / term.cols)) + 1),
        );
        const row = Math.max(
          1,
          Math.min(term.rows, Math.floor((event.clientY - rect.top) / (rect.height / term.rows)) + 1),
        );
        const seq = term.getMode(1006, false)
          ? `\x1b[<${button};${col};${row}M`
          : `\x1b[M${String.fromCharCode(button + 32, Math.min(col + 32, 255), Math.min(row + 32, 255))}`;
        for (let i = 0; i < Math.abs(ticks); i++) ws.send(seq);
      } else {
        // Alt screen, no mouse tracking: throttled arrow keys.
        const arrow = ticks > 0 ? '\x1b[B' : '\x1b[A';
        for (let i = 0; i < Math.abs(ticks); i++) ws.send(arrow);
      }
      return true;
    });

    termRef.current = term;
    fitRef.current = fitAddon;
    registry?.set(paneId, term);
    // Also register in the store so actions outside the pane tree (capture-pane
    // in useKeybindings) can read this pane's emulator buffer.
    useStore.getState().registerTerminal(paneId, term);

    let ws: WebSocket | null = null;
    let ready = false;

    // Connect only after the container has settled at its final CSS-computed size.
    // ResizeObserver can fire multiple times during a split: first at a tiny
    // intermediate size (e.g. 29×9) before percentage-based layout resolves, then
    // again at the correct size. Opening the WebSocket too early means the backend
    // replays scrollback at the wrong cols, producing garbled output. We defer the
    // initial connection with rAF so the browser has committed the final layout.
    // Push the terminal's current grid size to the title bar, skipping no-op
    // updates so we don't re-render on every ResizeObserver tick.
    const syncDims = () =>
      setDims((prev) =>
        prev?.cols === term.cols && prev?.rows === term.rows ? prev : { cols: term.cols, rows: term.rows },
      );

    let applyingServerSize = false;
    let disposed = false;
    let reconnectTimer = 0;
    let attempts = 0;
    let connectRaf = 0;
    let revealRaf = 0;
    const connect = () => {
      if (disposed || ws) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/pane/${paneId}?cols=${term.cols}&rows=${term.rows}`,
      );
      ws = socket;
      wsRef.current = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (disposed || ws !== socket) return;
        attempts = 0;
        // Server replay starts with a reset and a canonical screen snapshot.
        setConnectionError(null);
      };
      socket.onmessage = (ev) => {
        if (disposed || ws !== socket) return;
        if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
        else {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'ready') {
              ready = true;
              // All replay bytes have now been parsed. Terminal writes normally
              // coalesce behind one queued render; schedule our reveal after it
              // so the first visible canvas contains the completed screen.
              term.requestRender();
              cancelAnimationFrame(revealRaf);
              revealRaf = requestAnimationFrame(() => {
                if (disposed || ws !== socket) return;
                setInitialReplayRendered(true);
                setConnection('connected');
              });
            }
            if (msg.type === 'error') setConnectionError(msg.message);
            if (msg.type === 'size') {
              applyingServerSize = true;
              term.resize(msg.cols, msg.rows);
              applyingServerSize = false;
            }
          } catch {
            /* Unknown protocol frames are not terminal input. */
          }
        }
      };
      socket.onclose = () => {
        if (disposed || ws !== socket) return;
        ws = null;
        ready = false;
        wsRef.current = null;
        setConnection('reconnecting');
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      };
      socket.onerror = () => socket.close();
    };
    const onData = term.onData((data: string) => {
      if (ws?.readyState === WebSocket.OPEN && ready) {
        const bytes = new TextEncoder().encode(data);
        for (let i = 0; i < bytes.length; i += 16384) ws.send(bytes.slice(i, i + 16384));
      }
      if (term.viewportY !== 0) term.scrollToBottom();
      const rect = container.getBoundingClientRect();
      const cursor = term.buffer.active;
      announceWallpaperKeyboardCursor(
        rect.left + ((cursor.cursorX + 0.5) / Math.max(1, term.cols)) * rect.width,
        rect.top + ((cursor.cursorY + 0.5) / Math.max(1, term.rows)) * rect.height,
      );
    });
    const onResize = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      setDims({ cols, rows });
      if (ws?.readyState === WebSocket.OPEN && visibleRef.current && !applyingServerSize) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      fitAddon.fit();
      syncDims();
      if (!ws && !reconnectTimer) {
        cancelAnimationFrame(connectRaf);
        connectRaf = requestAnimationFrame(() => {
          if (!visibleRef.current) return;
          fitAddon.fit();
          syncDims();
          connect();
        });
      }
    });

    observer.observe(container);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      onData.dispose();
      onResize.dispose();
      fontAbort = true;
      cancelAnimationFrame(connectRaf);
      cancelAnimationFrame(revealRaf);
      observer.disconnect();
      ws?.close();
      term.dispose();
      if (registry && registry.get(paneId) === term) registry.delete(paneId);
      useStore.getState().unregisterTerminal(paneId, term);
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
    // Rebuilding on termOptions re-themes existing panes after a live config
    // reload; the pane socket replays scrollback on reconnect so content is kept.
  }, [paneId, termOptions, registry]);

  // Park / wake the terminal as it leaves / enters the active window. Hidden
  // panes stay mounted (their socket keeps streaming into the WASM terminal) but
  // suspend() stops the render loop so they cost ~0 CPU. On the way back in we
  // resume and fit: the container regained its real size, and if the pane was
  // first created while hidden it may still be unconnected — fit() drives the
  // ResizeObserver, which then opens the socket at the correct cols/rows.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (visible) {
      term.resume();
      fitRef.current?.fit();
    } else {
      term.suspend();
    }
  }, [visible, termOptions]);

  // The persistent post-process effect chosen with `shader: choose effect`
  // (config `shader = "..."`). It is the *base* state of this pane's
  // post-process slot: the transient effects below (and the privacy pixelate
  // in App.tsx) temporarily take the slot over and restore this on the way
  // out, hence baseShaderSrc rather than a plain `null`. Re-runs on
  // termOptions because a config reload rebuilds the Terminal, which drops
  // whatever shader was installed on the old renderer.
  const shaderId = config?.shader ?? null;
  useEffect(() => {
    termRef.current?.renderer?.setPostProcessShader?.(findShaderEffect(shaderId)?.src ?? null);
  }, [shaderId, termOptions]);

  // u_time-driven effects only animate while frames keep coming, and an idle
  // terminal paints none — so a visible pane with an animated base effect
  // needs a permanent render pump (Infinity: cancelled by the cleanup, never
  // by timeout). Hidden panes are suspended, and `animations = false` opts out
  // of motion entirely; both leave the effect installed but frozen.
  const baseShaderAnimated = findShaderEffect(shaderId)?.animated ?? false;
  const pumpBaseShader = baseShaderAnimated && visible && getAnimations(config);
  useEffect(() => {
    if (!pumpBaseShader) return;
    return pumpRenders(() => [termRef.current?.renderer], Infinity);
  }, [pumpBaseShader, termOptions]);

  // Play the configured one-shot pane-switch effect (`pane-switch-shader`, off
  // by default) when this pane *gains* active status while
  // visible — pane-to-pane navigation (prefix+arrow, click), and also a
  // window/session switch (whose newly-active pane transitions visible+
  // active in the same update, so it reads as "revealing" the pane you
  // switched to). Runs inside ghostty-web's own WebGL context
  // (setPostProcessShader) — no extra DOM node, no cross-context canvas copy.
  // An earlier external-overlay prototype (canvasFx.ts, removed) copied the
  // live canvas into a second WebGL context every frame and measurably stalled
  // typing; this hook was added to ghostty-web to avoid that class of bug. The
  // effect's own animation needs continuous frames the terminal wouldn't
  // otherwise paint while idle, hence the pump — see pumpRenders.ts.
  const paneSwitchShaderId = config?.pane_switch_shader ?? null;
  const paneSwitchIntensity = getPaneSwitchIntensity(config);
  const paneSwitchDuration = getPaneSwitchDuration(config);
  // Memoized so identity is stable across renders that don't touch these three
  // config values — the effect below fires on *identity* change, and building
  // a fresh object (findPaneSwitchEffect regenerates GLSL from the intensity/
  // duration multipliers) on every render would replay the flash constantly.
  const paneSwitchEffect = useMemo(
    () => findPaneSwitchEffect(paneSwitchShaderId, paneSwitchIntensity, paneSwitchDuration),
    [paneSwitchShaderId, paneSwitchIntensity, paneSwitchDuration],
  );
  const prevIsActiveForSwitchFx = useRef(isActive);
  useEffect(() => {
    const wasActive = prevIsActiveForSwitchFx.current;
    prevIsActiveForSwitchFx.current = isActive;
    const animations = getAnimations(config);
    if (wasActive || !isActive || !visible || !animations) return;

    const term = termRef.current;
    if (!term || !paneSwitchEffect.src) return;
    term.renderer?.setPostProcessShader?.(paneSwitchEffect.src);
    return pumpRenders(
      () => [term.renderer],
      paneSwitchEffect.durationMs,
      () => term.renderer?.setPostProcessShader?.(baseShaderSrc()),
    );
  }, [isActive, visible, config?.animations, paneSwitchEffect]);

  // One-shot border-draw effect on the pane you switch to (`pane-switch-border`,
  // style-selectable, `trace` by default; null = disabled). Pure CSS/SVG, keyed
  // on this nonce so the element remounts and replays on every activation. Same
  // activation transitions as the pane-switch shader above: pane-to-pane nav,
  // and a window/session switch (where the newly active pane goes visible+active
  // in one update). The nonce doubles as a mounted flag — bumped on activation,
  // cleared once the draw+fade has run so an idle pane carries no leftover node.
  const paneSwitchBorderStyleId = getPaneSwitchBorderStyle(config);
  const paneSwitchBorderStyle = paneSwitchBorderStyleId ? findPaneBorderStyle(paneSwitchBorderStyleId) : null;
  const paneSwitchBorderSpeed = getPaneSwitchBorderSpeed(config);
  const [borderTraceNonce, setBorderTraceNonce] = useState(0);
  const prevIsActiveForBorderTrace = useRef(isActive);
  useEffect(() => {
    const wasActive = prevIsActiveForBorderTrace.current;
    prevIsActiveForBorderTrace.current = isActive;
    if (wasActive || !isActive || !visible) return;
    if (!paneSwitchBorderStyle || !getAnimations(config)) return;
    setBorderTraceNonce((nonce) => nonce + 1);
    const done = setTimeout(() => setBorderTraceNonce(0), (paneSwitchBorderSpeed + 0.35) * 1000);
    return () => clearTimeout(done);
  }, [isActive, visible, config?.animations, paneSwitchBorderStyleId, paneSwitchBorderSpeed]);

  // Hide cursor on inactive panes by blending it into the background.
  // term.options.theme is unsupported after open(); go directly to the renderer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const bg = config?.theme?.background ?? DEFAULT_THEME.background;
    const cursor = config?.theme?.cursor ?? DEFAULT_THEME.cursor;
    term.renderer?.setTheme({
      ...(config?.theme ?? DEFAULT_THEME),
      cursor: isActive ? cursor : bg,
    });
  }, [isActive, config?.theme, termOptions]);

  // Focus when this pane becomes active (false→true transition, including mount),
  // when its initial replay finishes, or when an overlay closes while this pane
  // is active. Blur when it is inactive, not yet ready for keyboard input, or a
  // modal surface owns the keyboard.
  // Tracking the previous value prevents the old active pane from re-stealing
  // focus while a select_pane command is still in flight to the server.
  // Note: ghostty-web's open() auto-focuses every terminal as it mounts (and
  // schedules a deferred setTimeout(0) focus), so on a window switch the
  // last-mounted pane would otherwise win. The blur here plus SessionPane's
  // deferred re-focus of the active pane resolve that race.
  const prevIsActive = useRef(false);
  const prevOverlay = useRef(overlay);
  const prevFileBrowser = useRef(fileBrowserOpen);
  const prevInitialReplayRendered = useRef(false);
  useEffect(() => {
    const wasActive = prevIsActive.current;
    const hadOverlay = prevOverlay.current;
    const hadFileBrowser = prevFileBrowser.current;
    const hadRenderedInitialReplay = prevInitialReplayRendered.current;
    prevIsActive.current = isActive;
    prevOverlay.current = overlay;
    prevFileBrowser.current = fileBrowserOpen;
    prevInitialReplayRendered.current = initialReplayRendered;

    const keyboardOwnedElsewhere = overlay || windowGridOpen || switcherOpen || fileBrowserOpen;

    if (!isActive || keyboardOwnedElsewhere || !initialReplayRendered) {
      termRef.current?.blur();
      return;
    }

    const becameActive = !wasActive;
    const replayFinished = !hadRenderedInitialReplay;
    const overlayClosed = (!overlay && !!hadOverlay) || (!fileBrowserOpen && hadFileBrowser);
    if (becameActive || replayFinished || overlayClosed) {
      termRef.current?.focus();
    }
  }, [isActive, overlay, windowGridOpen, switcherOpen, fileBrowserOpen, initialReplayRendered]);

  // When the user clicks this pane, tell the backend to make it active so the
  // border and server-side state stay in sync with DOM focus.
  const onMouseDown = () => {
    if (!isActive) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
  };

  const borderActive = config?.theme?.blue ?? DEFAULT_THEME.blue;
  const borderInactive = config?.theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;
  const borderZoomed = config?.theme?.magenta ?? DEFAULT_THEME.magenta;
  const borderColor = isZoomed ? borderZoomed : isActive ? borderActive : borderInactive;
  // Brighter than the resting focus ring so the draw reads as motion on top of
  // the (already accent-colored) static border; `borderEdgeColor` is the near-
  // white leading edge for the `sweep` style.
  const borderTraceColor = mix(borderColor, config?.theme?.foreground ?? DEFAULT_THEME.foreground, 0.55);
  const borderEdgeColor = mix(borderColor, '#ffffff', 0.7);
  const animations = getAnimations(config);
  const showTitle = getShowPaneTitles(config);
  const termFont = getTerminalFontSize(config);
  const notification = useStore((s) => s.notifications.get(paneId));
  const notifColor = notification ? notificationColorFor(notification.level, config?.theme ?? null) : null;

  const accentGlow = withAlpha(borderColor, 0.2);

  return (
    <div
      ref={outerRef}
      onMouseDown={onMouseDown}
      style={{
        // Panes of inactive windows stay mounted but hidden (the keep-alive
        // pool). display:none detaches them from layout so they don't paint or
        // intercept clicks; the suspend() effect stops their render loop.
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        position: 'absolute',
        top: `${rect.top}%`,
        left: `${rect.left}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
        border: `1px solid ${isActive || isZoomed ? 'transparent' : borderColor}`,
        overflow: 'hidden',
        caretColor: 'transparent',
        // A zoomed pane fills the grid and must paint over the panes it covers
        // (which stay mounted). Above dividers' zIndex of 10.
        zIndex: isZoomed ? 20 : undefined,
        transition: animations ? 'border-color .15s ease, background .15s ease' : undefined,
      }}
    >
      {connection !== 'connected' && (
        <div
          role="status"
          className="absolute inset-x-0 top-0 text-center text-sm bg-background text-foreground"
          style={{ zIndex: 30 }}
        >
          {connectionError ?? (connection === 'connecting' ? 'Connecting…' : 'Connection lost. Reconnecting…')}
        </div>
      )}
      {showTitle && (
        <PaneTitleBar
          theme={config?.theme ?? null}
          index={paneIndex ?? 0}
          title={title}
          cwd={cwd}
          agentStatus={agentStatus}
          cols={dims?.cols ?? null}
          rows={dims?.rows ?? null}
          isActive={isActive}
          notificationColor={notifColor}
          termFont={termFont}
        />
      )}
      {!showTitle && <AgentStatusBadge theme={config?.theme ?? null} status={agentStatus} overlay />}
      {/* Focus ring — only rendered on the active/zoomed pane so mounting it
          replays btm-bloom on every focus change without needing a key trick. */}
      {(isActive || isZoomed) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: `1.5px solid ${borderColor}`,
            boxShadow: `0 0 0 1px ${borderColor}, 0 0 26px ${accentGlow}`,
            pointerEvents: 'none',
            animation: animations ? 'btm-bloom .3s cubic-bezier(.2,.8,.2,1)' : undefined,
            zIndex: 1,
          }}
        />
      )}
      {/* One-shot pane-switch border draw. Keyed on the nonce so React remounts
          the element (restarting its CSS animation) on each activation. `trace`
          is an SVG stroke wound counter-clockwise (pathLength 100, offset 100→0);
          the other styles are border-image gradient draws driven by the custom
          props set below. See lib/paneSwitchBorder.ts. */}
      {borderTraceNonce > 0 &&
        animations &&
        paneSwitchBorderStyle &&
        (isActive || isZoomed) &&
        (paneSwitchBorderStyle.render === 'svg' ? (
          <svg
            key={borderTraceNonce}
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{
              position: 'absolute',
              top: 1,
              left: 1,
              width: 'calc(100% - 2px)',
              height: 'calc(100% - 2px)',
              pointerEvents: 'none',
              overflow: 'visible',
              zIndex: 2,
            }}
          >
            <path
              d="M0 0 L0 100 L100 100 L100 0 Z"
              fill="none"
              stroke={borderTraceColor}
              strokeWidth={2.5}
              strokeLinecap="square"
              vectorEffect="non-scaling-stroke"
              pathLength={100}
              style={{
                strokeDasharray: 100,
                filter: `drop-shadow(0 0 6px ${withAlpha(borderColor, 0.9)}) drop-shadow(0 0 2px ${withAlpha(borderColor, 0.7)})`,
                animation: `btm-pane-border-trace ${paneSwitchBorderSpeed}s linear forwards, btm-fade-out .25s linear ${paneSwitchBorderSpeed}s forwards`,
              }}
            />
          </svg>
        ) : (
          <div
            key={borderTraceNonce}
            aria-hidden
            className={`btm-pane-border ${paneSwitchBorderStyle.className}`}
            style={
              {
                '--btm-border-speed': `${paneSwitchBorderSpeed}s`,
                '--btm-border-color': borderTraceColor,
                '--btm-border-edge': borderEdgeColor,
              } as CSSProperties
            }
          />
        ))}
      {/* The terminal fills the space below the (optional) title bar. inset-style
          padding around it keeps a small gutter so glyphs don't touch the border. */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          // Cover wallpaper/transparency only while the terminal canvas is
          // hidden; once revealed, restore the pane's normal transparency.
          background: initialReplayRendered ? 'transparent' : (config?.theme?.background ?? DEFAULT_THEME.background),
        }}
      >
        <div
          ref={containerRef}
          style={{
            position: 'absolute',
            inset: '8px',
            // `visibility` preserves layout, so FitAddon and ResizeObserver can
            // establish the correct grid while replay remains off-screen.
            visibility: initialReplayRendered ? 'visible' : 'hidden',
          }}
        />
      </div>
    </div>
  );
}

/** Notification-level → theme color (mirrors StatusBar). */
function notificationColorFor(level: NotificationLevel, theme: typeof DEFAULT_THEME | null): string {
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
