import { useEffect, useMemo, useRef } from 'react';
import { Terminal, FitAddon } from 'ghostty-web';
import { useStore } from '../state/store';
import { LayoutRect, ClientConfig } from '../state/types';
import { ClientMessage } from '../protocol/messages';
import { DEFAULT_THEME } from '../state/defaultTheme';

interface Props {
  sessionId: string;
  paneId: string;
  rect: LayoutRect;
  isActive: boolean;
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
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 72;

function buildFontFamily(configured: string | null | undefined): string {
  const base = configured ?? 'monospace';
  return `${base}, ${FONT_FALLBACK}`;
}

export function buildTerminalOptions(config: ClientConfig | null): ConstructorParameters<typeof Terminal>[0] | null {
  if (!config) return null;
  const t = config.terminal;
  const opts: ConstructorParameters<typeof Terminal>[0] = {
    fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, t?.fontSize ?? 14)),
    fontFamily: buildFontFamily(t?.fontFamily),
    theme: config?.theme ?? DEFAULT_THEME,
    cursorBlink: t?.cursorBlink ?? true,
  };
  // Experimental WebGL backend (ghostty-web fork); falls back to Canvas2D if
  // WebGL2 init fails. Omitted when unset so ghostty-web's canvas default applies.
  if (t?.renderer != null) opts.renderer = t.renderer;
  if (t?.cursorStyle != null) opts.cursorStyle = t.cursorStyle;
  if (t?.scrollback != null) opts.scrollback = t.scrollback;
  // When a wallpaper is configured, enable transparency so the image shows
  // through the terminal background; explicit allow-transparency still wins.
  const allowTransparency = t?.allowTransparency ?? (config?.wallpaper != null ? true : null);
  if (allowTransparency != null) opts.allowTransparency = allowTransparency;
  if (t?.convertEol != null) opts.convertEol = t.convertEol;
  if (t?.disableStdin != null) opts.disableStdin = t.disableStdin;
  if (t?.smoothScrollDuration != null) opts.smoothScrollDuration = t.smoothScrollDuration;
  // Non-upstream option consumed by our ghostty-web patch (see patches/).
  if (t?.scrollSensitivity != null) opts.scrollSensitivity = t.scrollSensitivity;
  if (t?.fontWeight != null) opts.fontWeight = t.fontWeight;
  return opts;
}

export function TerminalPane({ sessionId, paneId, rect, isActive, visible, isZoomed = false, registry, send }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read inside the ResizeObserver/rAF closures so they always see the current
  // visibility without re-running the mount effect (which would dispose+rebuild
  // the terminal). A hidden pane has a 0-size container, so it must neither fit
  // nor open its socket — doing so would size the PTY to garbage.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const config = useStore((s) => s.config);
  const overlay = useStore((s) => s.overlay);
  const termOptions = useMemo(() => buildTerminalOptions(config), [config]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !termOptions) return;

    const term = new Terminal(termOptions);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    // ghostty-web's open() auto-focuses (and schedules a deferred setTimeout(0)
    // focus); undo both if an overlay is active so the picker keeps focus.
    if (useStore.getState().overlay) {
      term.blur();
      setTimeout(() => {
        if (useStore.getState().overlay) term.blur();
      }, 0);
    }

    // Explicitly load the configured font at the requested weight so the browser
    // fetches the woff2 before we measure/rasterize. Without this, Canvas2D
    // measureText doesn't trigger @font-face downloads — the font only loads when
    // DOM text is rendered, causing the first Terminal to use a fallback/synthesized
    // weight until a config change forces a rebuild.
    let fontAbort = false;
    const weight = termOptions.fontWeight ?? 400;
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
      fitAddon.fit();
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
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;

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

    // Connect only after the container has settled at its final CSS-computed size.
    // ResizeObserver can fire multiple times during a split: first at a tiny
    // intermediate size (e.g. 29×9) before percentage-based layout resolves, then
    // again at the correct size. Opening the WebSocket too early means the backend
    // replays scrollback at the wrong cols, producing garbled output. We defer the
    // initial connection with rAF so the browser has committed the final layout.
    let connectRaf = 0;
    const observer = new ResizeObserver(() => {
      // While hidden the container is display:none (0×0); fitting would resize
      // the PTY to a 1-cell grid and connecting would replay scrollback at the
      // wrong size. Skip both — the visibility effect fits on the way back in.
      if (!visibleRef.current) return;
      fitAddon.fit();
      if (!ws) {
        cancelAnimationFrame(connectRaf);
        connectRaf = requestAnimationFrame(() => {
          if (ws || !visibleRef.current) return;
          fitAddon.fit();
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = `${protocol}//${window.location.host}/ws/pane/${paneId}?cols=${term.cols}&rows=${term.rows}`;
          ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          wsRef.current = ws;

          ws.onmessage = (ev) => {
            if (ev.data instanceof ArrayBuffer) {
              term.write(new Uint8Array(ev.data));
            } else if (typeof ev.data === 'string') {
              term.write(ev.data);
            }
          };

          term.onData((data: string) => {
            if (ws!.readyState === WebSocket.OPEN) ws!.send(data);
          });

          term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            if (ws!.readyState === WebSocket.OPEN) {
              ws!.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
          });
        });
      }
    });

    observer.observe(container);

    return () => {
      fontAbort = true;
      cancelAnimationFrame(connectRaf);
      observer.disconnect();
      ws?.close();
      term.dispose();
      if (registry?.get(paneId) === term) registry.delete(paneId);
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
  }, [visible]);

  // Hide cursor on inactive panes by blending it into the background.
  // term.options.theme is unsupported after open(); go directly to the renderer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const bg = config?.theme?.background ?? DEFAULT_THEME.background;
    const cursor = config?.theme?.cursor ?? DEFAULT_THEME.cursor;
    term.renderer?.setTheme({
      ...term.options.theme,
      cursor: isActive ? cursor : bg,
    });
  }, [isActive, config?.theme?.background, config?.theme?.cursor, termOptions]);

  // Focus when this pane becomes active (false→true transition, including mount)
  // or when an overlay closes while this pane is active; blur when it is not
  // active so it can't keep keyboard focus after losing the highlight.
  // Tracking the previous value prevents the old active pane from re-stealing
  // focus while a select_pane command is still in flight to the server.
  // Note: ghostty-web's open() auto-focuses every terminal as it mounts (and
  // schedules a deferred setTimeout(0) focus), so on a window switch the
  // last-mounted pane would otherwise win. The blur here plus SessionPane's
  // deferred re-focus of the active pane resolve that race.
  const prevIsActive = useRef(false);
  const prevOverlay = useRef(overlay);
  useEffect(() => {
    const wasActive = prevIsActive.current;
    const hadOverlay = prevOverlay.current;
    prevIsActive.current = isActive;
    prevOverlay.current = overlay;

    if (!isActive) {
      termRef.current?.blur();
      return;
    }

    const becameActive = !wasActive;
    const overlayClosed = !overlay && !!hadOverlay;
    if ((becameActive || overlayClosed) && !overlay) {
      termRef.current?.focus();
    }
  }, [isActive, overlay]);

  // When the user clicks this pane, tell the backend to make it active so the
  // border and server-side state stay in sync with DOM focus.
  const onMouseDown = () => {
    if (!isActive) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
  };

  const borderActive = config?.theme?.blue ?? DEFAULT_THEME.blue;
  const borderInactive = config?.theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;
  const borderZoomed = config?.theme?.magenta ?? DEFAULT_THEME.magenta;
  const borderColor = isZoomed ? borderZoomed : isActive ? borderActive : borderInactive;
  const animations = config?.animations ?? true;

  return (
    <div
      ref={outerRef}
      onMouseDown={onMouseDown}
      style={{
        // Panes of inactive windows stay mounted but hidden (the keep-alive
        // pool). display:none detaches them from layout so they don't paint or
        // intercept clicks; the suspend() effect stops their render loop.
        display: visible ? undefined : 'none',
        position: 'absolute',
        top: `${rect.top}%`,
        left: `${rect.left}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
        border: `1px solid ${borderColor}`,
        overflow: 'hidden',
        caretColor: 'transparent',
        // A zoomed pane fills the grid and must paint over the panes it covers
        // (which stay mounted). Above dividers' zIndex of 10.
        zIndex: isZoomed ? 20 : undefined,
        transition: animations ? 'border-color 200ms ease-out' : undefined,
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: '4px' }} />
    </div>
  );
}
