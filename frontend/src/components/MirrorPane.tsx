import { useEffect, useRef, useState } from 'react';
import { PaneTerminal } from '../lib/paneTerminal';
import { useStore } from '../state/store';
import { terminalTransparency, useTerminalOptions } from './TerminalPane';
import type { ClientConfig } from '../state/types';
import { STARTUP_THEME } from '../state/startupTheme';
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from '../state/configDefaults';

interface Props {
  paneId: string;
  /** Optional draft config used by the settings-page preview. */
  config?: ClientConfig | null;
  /**
   * Whether the thumbnail is on-screen (the window-grid is open). A mirror stays
   * mounted and streaming while hidden so reopening is instant, but pauses
   * painting (~0 CPU) — the same warm pattern as TerminalPane. On the way
   * back in we resume and recompute the fit-scale (offsetWidth is 0 while hidden).
   */
  visible: boolean;
  /** Reports the terminal's natural (unscaled) pixel size whenever it changes. */
  onNaturalSize?: (width: number, height: number) => void;
}

/**
 * A read-only, scaled-down live mirror of a pane, used as a window-grid thumbnail.
 *
 * Unlike TerminalPane it never sends input or resizes the PTY: a PTY has a single
 * shared size, so a thumbnail must adopt the pane's *real* cols×rows (pushed by
 * the backend via `{type:"size"}` frames over `?mirror=1`) and then shrink purely
 * with CSS `transform: scale(...)`. Sizing the emulator small instead would reflow
 * the live shell and clear its scrollback. DOM text re-renders at the scaled size,
 * so TUIs stay faithful.
 */
export function MirrorPane({ paneId, config: configOverride, visible, onNaturalSize }: Props) {
  const cellRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<PaneTerminal | null>(null);
  const replayReadyRef = useRef(false);
  const revealRef = useRef<(() => void) | null>(null);
  const revealRafRef = useRef(0);
  const [initialReplayRendered, setInitialReplayRendered] = useState(false);

  const storeConfig = useStore((s) => s.config);
  const config = configOverride ?? storeConfig;
  const termOptions = useTerminalOptions(config);

  // Read visibility inside closures without re-running the mount effect (which
  // would dispose+rebuild the terminal and reconnect the socket).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  useEffect(() => {
    const scaler = scalerRef.current;
    if (!scaler || !termOptions) return;
    let disposed = false;
    let cleanup = () => {};
    void PaneTerminal.open(scaler, { ...termOptions, disableStdin: true }).then((term) => {
      if (disposed) return term.dispose();
      cleanup = mount(term);
    });

    const mount = (term: PaneTerminal) => {
      // Size the emulator to its grid, then scale that natural size into the
      // grid cell, preserving aspect ratio and anchoring top-left.
      const refit = () => {
        const cell = cellRef.current;
        const size = term.measureCell();
        if (!cell || !size) return;
        const naturalW = term.cols * size.width;
        const naturalH = term.rows * size.height;
        term.element.style.width = `${naturalW}px`;
        term.element.style.height = `${naturalH}px`;
        onNaturalSizeRef.current?.(naturalW, naturalH);
        scaler.style.transform = `scale(${Math.min(cell.clientWidth / naturalW, cell.clientHeight / naturalH)})`;
      };
      // Keep painting stopped until the replay's `ready` marker.
      term.setPaused(true);
      setTerm(term);
      setInitialReplayRendered(false);
      replayReadyRef.current = false;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // cols/rows in the query only matter if this mirror is the very first attach
      // to a never-spawned pane (spawns the shell at this size); a real viewer will
      // resize it on switch. The backend never resizes the PTY for a mirror.
      const url = `${protocol}//${window.location.host}/ws/pane/${paneId}?mirror=1&cols=${DEFAULT_PTY_COLS}&rows=${DEFAULT_PTY_ROWS}`;
      let ws: WebSocket;
      let timer = 0;
      const revealWhenReady = () => {
        if (disposed || !replayReadyRef.current || !visibleRef.current) return;
        term.setPaused(false);
        refit();
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (disposed || !visibleRef.current) return;
            term.scrollToBottom();
            setInitialReplayRendered(true);
          }),
        );
      };
      revealRef.current = revealWhenReady;
      const connect = () => {
        if (disposed) return;
        replayReadyRef.current = false;
        setInitialReplayRendered(false);
        term.setPaused(true);
        ws = new WebSocket(url);
        ws.onclose = () => {
          if (!disposed) timer = window.setTimeout(connect, 2000);
        };
        ws.onerror = () => ws.close();
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(ev.data));
          } else if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'ready') {
                replayReadyRef.current = true;
                revealWhenReady();
              }
              if (msg.type === 'size' && msg.cols > 0 && msg.rows > 0) {
                term.resize(msg.cols, msg.rows);
                refit();
              }
            } catch {
              term.write(ev.data);
            }
          }
        };
      };
      connect();

      const observer = new ResizeObserver(() => refit());
      if (cellRef.current) observer.observe(cellRef.current);

      return () => {
        clearTimeout(timer);
        cancelAnimationFrame(revealRafRef.current);
        if (revealRef.current === revealWhenReady) revealRef.current = null;
        replayReadyRef.current = false;
        observer.disconnect();
        ws.close();
        term.dispose();
        setTerm(null);
      };
    };

    return () => {
      disposed = true;
      cleanup();
    };
    // Rebuild on config/font change, matching TerminalPane. paneId is stable
    // for the component's lifetime.
  }, [paneId, termOptions]);

  const allowTransparency = terminalTransparency(config);
  useEffect(() => {
    term?.setTransparent(allowTransparency);
  }, [allowTransparency, term]);

  useEffect(() => {
    term?.setTheme(config?.theme ?? STARTUP_THEME);
  }, [config?.theme, term]);

  // Park / wake with the grid's visibility (sockets keep streaming either way).
  useEffect(() => {
    if (!term) return;
    if (visible) {
      revealRef.current?.();
    } else {
      cancelAnimationFrame(revealRafRef.current);
      term.setPaused(true);
    }
  }, [visible, term]);

  return (
    <div ref={cellRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        ref={scalerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: 'top left',
          visibility: initialReplayRendered ? 'visible' : 'hidden',
          // Block the terminal's own input affordances; the grid handles clicks.
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
