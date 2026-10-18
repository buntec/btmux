import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PaneTerminal, type PaneTerminalOptions } from '../lib/paneTerminal';
import { useStore } from '../state/store';
import { AgentStatus, LayoutRect, ClientConfig } from '../state/types';
import { ClientMessage } from '../protocol/messages';
import { STARTUP_THEME } from '../state/startupTheme';
import { PaneCorner, PaneTitleBar } from './PaneTitleBar';
import { mix, withAlpha } from '../lib/chrome-colors';
import { findPaneBorderStyle } from '../lib/paneSwitchBorder';
import { PaneBorderDraw } from './PaneBorderDraw';
import { announceWallpaperKeyboardCursor } from '../lib/wallpaperInteraction';
import { useLatexScan, type PaneLatexMatch } from '../lib/latexScan';
import { LatexOverlay } from './LatexOverlay';
import { PaneSearch } from './PaneSearch';
import { CONNECTION_STATE_LABEL, type ConnectionState } from '../lib/connectionState';
import { cn } from '../lib/utils';
import { desktopTransparency } from '../lib/desktopTransparency';
import {
  CONFIG_DEFAULTS,
  getAnimations,
  getPaneSwitchBorderSpeed,
  getPaneSwitchBorderStyle,
  getShowPaneTitles,
  getTerminalFontFamily,
  getTerminalFontSize,
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
   * `display:none` and paused so switches don't tear down and rebuild
   * emulators. See SessionPane for the pool rationale.
   */
  visible: boolean;
  /** True when this pane is the sole, fullscreen-zoomed pane of its window. */
  isZoomed?: boolean;
  /** Draft config applied locally while the settings overlay is open. */
  previewConfig?: ClientConfig | null;
  /**
   * Shared paneId→Terminal map owned by SessionPane. The pane registers its
   * Terminal here so SessionPane can authoritatively focus the active pane after
   * a window switch (see the focus race note in SessionPane).
   */
  registry?: Map<string, PaneTerminal>;
  send: (msg: ClientMessage) => void;
}

const FONT_FALLBACK = 'Symbols Nerd Font Mono, Menlo, Monaco, monospace';

export function buildFontFamily(configured: string): string {
  return `${configured}, ${FONT_FALLBACK}`;
}

export function buildTerminalOptions(config: ClientConfig | null): PaneTerminalOptions | null {
  if (!config) return null;
  const t = config.terminal;
  return {
    fontSize: getTerminalFontSize(config),
    fontFamily: buildFontFamily(getTerminalFontFamily(config)),
    fontWeight: t?.fontWeight ?? CONFIG_DEFAULTS.terminal.fontWeight,
    theme: config?.theme ?? STARTUP_THEME,
    cursorBlink: t?.cursorBlink ?? CONFIG_DEFAULTS.terminal.cursorBlink,
    scrollback: t?.scrollback ?? CONFIG_DEFAULTS.terminal.scrollback,
    disableStdin: t?.disableStdin ?? undefined,
  };
}

export function terminalTransparency(config: ClientConfig | null): boolean {
  if (!config) return false;
  // Let wallpapers and the desktop backdrop show through the terminal.
  const hasWallpaper = config.wallpaper != null || config.wallpaper_shader != null;
  return config.terminal?.allowTransparency ?? (hasWallpaper || desktopTransparency);
}

// Only construction options belong in the emulator lifetime key.
export function useTerminalOptions(config: ClientConfig | null) {
  const options = buildTerminalOptions(config);
  const key = JSON.stringify(options ? { ...options, theme: undefined } : null);
  return useMemo(
    () => options,
    // The theme is applied in place; only the key rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
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
  previewConfig = null,
  registry,
  send,
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<PaneTerminal | null>(null);
  // Mirrors termRef for render-time consumers (search, LaTeX scan).
  const [term, setTerm] = useState<PaneTerminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  // Live terminal dimensions, shown as "cols×rows" in the title bar. Updated from
  // the fit/resize path so the bar tracks the pane's real grid.
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  // Read inside the ResizeObserver/rAF closures so they always see the current
  // visibility without re-running the mount effect (which would dispose+rebuild
  // the terminal). A hidden pane has a 0-size container, so it must neither fit
  // nor open its socket — doing so would size the PTY to garbage.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const storeConfig = useStore((s) => s.config);
  const config = previewConfig ?? storeConfig;
  const overlay = useStore((s) => s.overlay);
  const windowGridOpen = useStore((s) => s.windowGridOpen);
  const agentGridOpen = useStore((s) => s.agentGridOpen);
  const switcherOpen = useStore((s) => s.switcherOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  // Whether the Neovim or VS Code surface is pinned over this pane.
  const nvimOpen = useStore(
    (s) => (s.nvimOpen && s.nvimPaneId === paneId) || (s.vscodeOpen && s.vscodePaneId === paneId),
  );
  const fileBrowserOpen = useStore((s) => s.fileBrowserOpen && s.fileBrowserPaneId === paneId);
  const termOptions = useTerminalOptions(config);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  // Keep a newly-created emulator hidden while the server streams its initial
  // checkpoint + journal. Parsing writes is synchronous, but paints happen on
  // animation frames; revealing only after the frame queued by `ready` avoids
  // showing a long replay as rapidly scrolling terminal output.
  const [initialReplayRendered, setInitialReplayRendered] = useState(false);
  // Set below; the socket handler calls it after each write to rescan for LaTeX.
  const latexPokeRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !termOptions) return;
    setConnection('connecting');
    setInitialReplayRendered(false);

    let disposed = false;
    let cleanup = () => {};
    const start = async () => {
      let term: PaneTerminal;
      try {
        term = await PaneTerminal.open(container, termOptions);
      } catch (e) {
        if (!disposed) setConnectionError(String(e));
        return;
      }
      if (disposed) {
        term.dispose();
        return;
      }
      cleanup = mount(term);
    };

    const mount = (term: PaneTerminal) => {
      termRef.current = term;
      setTerm(term);
      registry?.set(paneId, term);
      // Also register in the store so actions outside the pane tree (capture-pane
      // in useKeybindings) can read this pane's emulator buffer.
      useStore.getState().registerTerminal(paneId, term);

      let ws: WebSocket | null = null;
      let ready = false;

      const syncDims = () =>
        setDims((prev) =>
          prev?.cols === term.cols && prev?.rows === term.rows ? prev : { cols: term.cols, rows: term.rows },
        );

      // Size ownership: the owner's container size drives the PTY. Followers
      // report their size (applied when they claim) but keep the server's grid:
      // a local resize reflows and clears the prompt, and the shell never
      // redraws because the PTY size did not change.
      let owner = true;
      let claimed = false;
      let serverSize: { cols: number; rows: number } | null = null;
      let reported = '';
      const report = (cols: number, rows: number) => {
        const key = `${cols}x${rows}`;
        if (ws?.readyState !== WebSocket.OPEN || !visibleRef.current || key === reported) return;
        reported = key;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      };
      const adoptServerSize = () => {
        if (serverSize) term.resize(serverSize.cols, serverSize.rows);
      };
      const fit = () => {
        const size = term.proposeDimensions();
        if (!size) return;
        if (!owner) adoptServerSize();
        else term.resize(size.cols, size.rows);
        report(size.cols, size.rows);
      };
      fitRef.current = fit;
      const claim = () => {
        if (owner || claimed || ws?.readyState !== WebSocket.OPEN) return;
        claimed = true;
        fit();
        ws.send(JSON.stringify({ type: 'claim' }));
      };
      container.addEventListener('keydown', claim, true);
      container.addEventListener('paste', claim, true);
      container.addEventListener('mousedown', claim, true);

      let reconnectTimer = 0;
      let attempts = 0;
      let connectRaf = 0;
      let revealRaf = 0;
      const connect = () => {
        if (disposed || ws) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const size = term.proposeDimensions() ?? { cols: term.cols, rows: term.rows };
        reported = `${size.cols}x${size.rows}`;
        claimed = false;
        const socket = new WebSocket(
          `${protocol}//${window.location.host}/ws/pane/${paneId}?cols=${size.cols}&rows=${size.rows}`,
        );
        ws = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
          if (disposed || ws !== socket) return;
          attempts = 0;
          setConnectionError(null);
        };
        socket.onmessage = (ev) => {
          if (disposed || ws !== socket) return;
          if (ev.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(ev.data));
            latexPokeRef.current();
          } else {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'ready') {
                ready = true;
                // wterm paints on the next frame; reveal after it.
                cancelAnimationFrame(revealRaf);
                revealRaf = requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    if (disposed || ws !== socket) return;
                    term.scrollToBottom();
                    setInitialReplayRendered(true);
                    setConnection('connected');
                  }),
                );
              }
              if (msg.type === 'error') setConnectionError(msg.message);
              if (msg.type === 'size') {
                // Applied in stream order, so output is parsed at the size it was
                // produced for. The owner's own echo is a no-op.
                serverSize = { cols: msg.cols, rows: msg.rows };
                term.resize(msg.cols, msg.rows);
              }
              if (msg.type === 'owner') {
                owner = msg.owner;
                claimed = false;
                if (owner) fit();
                else adoptServerSize();
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
          setConnection('reconnecting');
          reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
        };
        socket.onerror = () => socket.close();
      };
      const offData = term.onData((bytes) => {
        if (ws?.readyState === WebSocket.OPEN && ready) {
          for (let i = 0; i < bytes.length; i += 16384) ws.send(bytes.slice(i, i + 16384));
        }
        const rect = container.getBoundingClientRect();
        const cursor = term.cursor();
        announceWallpaperKeyboardCursor(
          rect.left + ((cursor.col + 0.5) / Math.max(1, term.cols)) * rect.width,
          rect.top + ((cursor.row + 0.5) / Math.max(1, term.rows)) * rect.height,
        );
      });
      const offResize = term.onResize((cols, rows) => setDims({ cols, rows }));
      const observer = new ResizeObserver(() => {
        if (!visibleRef.current) return;
        fit();
        syncDims();
        if (!ws && !reconnectTimer) {
          cancelAnimationFrame(connectRaf);
          connectRaf = requestAnimationFrame(() => {
            if (!visibleRef.current) return;
            fit();
            syncDims();
            connect();
          });
        }
      });
      observer.observe(container);
      // Refit after wterm remeasures cells; its observer runs first.
      term.observeCellSize(observer);

      return () => {
        clearTimeout(reconnectTimer);
        offData();
        offResize();
        container.removeEventListener('keydown', claim, true);
        container.removeEventListener('paste', claim, true);
        container.removeEventListener('mousedown', claim, true);
        cancelAnimationFrame(connectRaf);
        cancelAnimationFrame(revealRaf);
        observer.disconnect();
        ws?.close();
        term.dispose();
        if (registry && registry.get(paneId) === term) registry.delete(paneId);
        useStore.getState().unregisterTerminal(paneId, term);
        termRef.current = null;
        setTerm(null);
        fitRef.current = null;
      };
    };

    void start();

    return () => {
      disposed = true;
      cleanup();
    };
    // Rebuilding on termOptions re-themes existing panes after a live config
    // reload; the pane socket replays scrollback on reconnect so content is kept.
  }, [paneId, termOptions, registry]);

  // LaTeX detection (lib/latexDetect.ts).
  // A pane under the built-in Neovim keeps its geometry but needn't render.
  const rendering = visible && !nvimOpen;
  const { matches: latexMatches, poke: latexPoke } = useLatexScan(term, rendering);
  latexPokeRef.current = latexPoke;
  const latexOpen = useStore((s) => s.latexPanes.has(paneId));
  const searchOpen = useStore((s) => s.searchPaneId === paneId);
  const toggleLatex = () => useStore.getState().toggleLatex(paneId);
  const highlightLatex = (match: PaneLatexMatch | null) => {
    if (!term) return;
    if (!match) return term.clearDecorations();
    const background = withAlpha(config?.theme?.yellow ?? STARTUP_THEME.yellow, 0.35);
    term.setDecorations(match.cells.map((cell) => ({ ...cell, background })));
  };
  // Highlights hold absolute buffer lines, which go stale on any rescan.
  useEffect(() => {
    term?.clearDecorations();
  }, [term, latexOpen, latexMatches]);

  // Park / wake the terminal as it leaves / enters the active window. Hidden
  // panes stay mounted (their socket keeps streaming into the WASM terminal) but
  // pausing stops painting so they cost ~0 CPU. On the way back in we
  // resume and fit: the container regained its real size, and if the pane was
  // first created while hidden it may still be unconnected — fit() drives the
  // ResizeObserver, which then opens the socket at the correct cols/rows.
  useEffect(() => {
    if (!term) return;
    term.setPaused(!rendering);
    if (rendering) fitRef.current?.();
  }, [rendering, term]);

  const allowTransparency = terminalTransparency(config);
  useEffect(() => {
    term?.setTransparent(allowTransparency);
  }, [allowTransparency, term]);

  // One-shot border-draw effect on the pane you switch to (`pane-switch-border`,
  // style-selectable, `wipe` by default; null = disabled). Pure CSS, keyed
  // on this nonce so the element remounts and replays on every activation:
  // pane-to-pane nav, and a window/session switch (where the newly active pane
  // goes visible+active in one update). The nonce doubles as a mounted flag — bumped on activation,
  // cleared once the draw+fade has run so an idle pane carries no leftover node.
  const paneSwitchBorderStyleId = getPaneSwitchBorderStyle(config);
  const paneSwitchBorderStyle = paneSwitchBorderStyleId ? findPaneBorderStyle(paneSwitchBorderStyleId) : null;
  const paneSwitchBorderSpeed = getPaneSwitchBorderSpeed(config);
  const [borderTraceNonce, setBorderTraceNonce] = useState(0);
  const prevIsActiveForBorderTrace = useRef(isActive);
  // Layout effect so the ring is hidden before the first paint of an activation.
  useLayoutEffect(() => {
    const wasActive = prevIsActiveForBorderTrace.current;
    prevIsActiveForBorderTrace.current = isActive;
    if (wasActive || !isActive || !visible) return;
    if (!paneSwitchBorderStyle || !getAnimations(config)) return;
    setBorderTraceNonce((nonce) => nonce + 1);
    const done = setTimeout(() => setBorderTraceNonce(0), (paneSwitchBorderSpeed + 0.35) * 1000);
    return () => clearTimeout(done);
  }, [isActive, visible, config?.animations, paneSwitchBorderStyleId, paneSwitchBorderSpeed]);

  // Themes apply in place.
  useEffect(() => {
    term?.setTheme(config?.theme ?? STARTUP_THEME);
  }, [config?.theme, term]);
  useEffect(() => {
    term?.setCursorHidden(!isActive);
  }, [isActive, term]);

  // Focus when this pane becomes active (false→true transition, including mount),
  // when its initial replay finishes, or when an overlay closes while this pane
  // is active. Blur when it is inactive, not yet ready for keyboard input, or a
  // modal surface owns the keyboard.
  // Tracking the previous value prevents the old active pane from re-stealing
  // focus while a select_pane command is still in flight to the server.
  const prevIsActive = useRef(false);
  const prevOverlay = useRef(overlay);
  const prevFileBrowser = useRef(fileBrowserOpen);
  const prevNvimOpen = useRef(nvimOpen);
  const prevInitialReplayRendered = useRef(false);
  useEffect(() => {
    const wasActive = prevIsActive.current;
    const hadOverlay = prevOverlay.current;
    const hadFileBrowser = prevFileBrowser.current;
    const hadNvimOpen = prevNvimOpen.current;
    const hadRenderedInitialReplay = prevInitialReplayRendered.current;
    prevIsActive.current = isActive;
    prevOverlay.current = overlay;
    prevFileBrowser.current = fileBrowserOpen;
    prevNvimOpen.current = nvimOpen;
    prevInitialReplayRendered.current = initialReplayRendered;

    const keyboardOwnedElsewhere =
      settingsOpen || overlay || windowGridOpen || agentGridOpen || switcherOpen || fileBrowserOpen || nvimOpen;

    if (!isActive || keyboardOwnedElsewhere || !initialReplayRendered) {
      termRef.current?.blur();
      return;
    }

    const becameActive = !wasActive;
    const replayFinished = !hadRenderedInitialReplay;
    const overlayClosed =
      (!overlay && !!hadOverlay) || (!fileBrowserOpen && hadFileBrowser) || (!nvimOpen && hadNvimOpen);
    if (becameActive || replayFinished || overlayClosed) {
      termRef.current?.focus();
    }
  }, [
    isActive,
    settingsOpen,
    overlay,
    windowGridOpen,
    agentGridOpen,
    switcherOpen,
    fileBrowserOpen,
    nvimOpen,
    initialReplayRendered,
  ]);

  // When the user clicks this pane, tell the backend to make it active so the
  // border and server-side state stay in sync with DOM focus.
  const onMouseDown = () => {
    if (!isActive) send({ type: 'select_pane', session_id: sessionId, pane_id: paneId });
  };

  const borderActive = config?.theme?.blue ?? STARTUP_THEME.blue;
  const borderInactive = config?.theme?.selectionBackground ?? STARTUP_THEME.selectionBackground;
  const borderZoomed = config?.theme?.magenta ?? STARTUP_THEME.magenta;
  const borderColor = isZoomed ? borderZoomed : isActive ? borderActive : borderInactive;
  // Near-white leading edge for the `sweep` style.
  const borderEdgeColor = mix(borderColor, '#ffffff', 0.7);
  const animations = getAnimations(config);
  const showTitle = getShowPaneTitles(config);
  const termFont = getTerminalFontSize(config);
  const notification = useStore(
    (s) =>
      s.allSessions
        .find((session) => session.id === sessionId)
        ?.windows.flatMap((win) => win.panes)
        .find((pane) => pane.id === paneId)?.unread?.level ?? null,
  );

  const accentGlow = withAlpha(borderColor, 0.2);
  const borderPlaying = borderTraceNonce > 0 && animations && paneSwitchBorderStyle !== null;

  return (
    <div
      ref={outerRef}
      data-pane-id={paneId}
      onMouseDown={onMouseDown}
      style={{
        // Panes of inactive windows stay mounted but hidden (the keep-alive
        // pool). display:none detaches them from layout so they don't paint or
        // intercept clicks; the pause effect stops their painting.
        display: visible ? 'flex' : 'none',
        // Preserve terminal geometry and sockets beneath the transparent editor.
        opacity: nvimOpen ? 0 : undefined,
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
          className={cn(
            'absolute inset-0 flex items-center justify-center text-sm text-secondary',
            animations && 'animate-pulse',
          )}
          style={{ zIndex: 30 }}
        >
          {connectionError ?? CONNECTION_STATE_LABEL[connection]}
        </div>
      )}
      {showTitle && (
        <PaneTitleBar
          index={paneIndex ?? 0}
          title={title}
          cwd={cwd}
          agentStatus={agentStatus}
          cols={dims?.cols ?? null}
          rows={dims?.rows ?? null}
          isActive={isActive}
          notification={notification}
          latexCount={latexMatches.length}
          latexOpen={latexOpen}
          onToggleLatex={toggleLatex}
        />
      )}
      {!showTitle && <PaneCorner index={paneIndex ?? 0} status={agentStatus} isActive={isActive} />}
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
            visibility: borderPlaying ? 'hidden' : undefined,
            zIndex: 1,
          }}
        />
      )}
      {/* One-shot pane-switch border draw. Keyed on the nonce so React remounts
          it (restarting its CSS animation) on each activation. It draws the
          focus ring itself, which stays hidden until the draw unmounts. */}
      {borderPlaying && (isActive || isZoomed) && (
        <PaneBorderDraw
          key={borderTraceNonce}
          className={paneSwitchBorderStyle.className}
          color={borderColor}
          edge={borderEdgeColor}
          seconds={paneSwitchBorderSpeed}
        />
      )}
      {/* The terminal fills the space below the (optional) title bar. inset-style
          padding around it keeps a small gutter so glyphs don't touch the border. */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          // Cover wallpaper/transparency only while the terminal canvas is
          // hidden; once revealed, restore the pane's normal transparency.
          background: initialReplayRendered ? 'transparent' : (config?.theme?.background ?? STARTUP_THEME.background),
        }}
      >
        <div
          ref={containerRef}
          className="absolute inset-3"
          style={{
            // `visibility` preserves layout, so the ResizeObserver can
            // establish the correct grid while replay remains off-screen.
            visibility: initialReplayRendered ? 'visible' : 'hidden',
          }}
        />
        {/* Without a title bar the LaTeX chip floats in the pane's corner. */}
        {!showTitle && !latexOpen && latexMatches.length > 0 && (
          <button
            type="button"
            title="Toggle LaTeX overlay"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleLatex}
            style={{
              position: 'absolute',
              top: 6,
              right: 10,
              padding: '1px 7px',
              borderRadius: 5,
              fontSize: Math.max(10, Math.round(termFont * 0.75)),
              fontWeight: 700,
              cursor: 'pointer',
              color: config?.theme?.background ?? STARTUP_THEME.background,
              background: withAlpha(borderActive, 0.85),
              zIndex: 5,
            }}
          >
            ∑ {latexMatches.length}
          </button>
        )}
        {searchOpen && term && (
          <PaneSearch
            term={term}
            theme={config?.theme ?? null}
            termFont={termFont}
            onClose={() => useStore.getState().setSearchPaneId(null)}
          />
        )}
        {latexOpen && (
          <LatexOverlay
            theme={config?.theme ?? null}
            termFont={termFont}
            matches={latexMatches}
            onHover={highlightLatex}
            onClose={toggleLatex}
          />
        )}
      </div>
    </div>
  );
}
