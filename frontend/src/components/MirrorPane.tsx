import { useEffect, useRef } from 'react';
import { Terminal } from 'ghostty-web';
import { useStore } from '../state/store';
import { buildTerminalOptions } from './TerminalPane';

interface Props {
  paneId: string;
  /**
   * Whether the thumbnail is on-screen (the window-grid is open). A mirror stays
   * mounted and streaming while hidden so reopening is instant, but suspend()s
   * its render loop (~0 CPU) — the same warm pattern as TerminalPane. On the way
   * back in we resume and recompute the fit-scale (offsetWidth is 0 while hidden).
   */
  visible: boolean;
}

/**
 * A read-only, scaled-down live mirror of a pane, used as a window-grid thumbnail.
 *
 * Unlike TerminalPane it never sends input or resizes the PTY: a PTY has a single
 * shared size, so a thumbnail must adopt the pane's *real* cols×rows (pushed by
 * the backend via `{type:"size"}` frames over `?mirror=1`) and then shrink purely
 * with CSS `transform: scale(...)`. Sizing the emulator small instead would reflow
 * the live shell and clear its scrollback. The canvas downscales cleanly, so TUIs
 * stay pixel-faithful.
 */
export function MirrorPane({ paneId, visible }: Props) {
  const cellRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  const config = useStore((s) => s.config);

  // Read visibility inside closures without re-running the mount effect (which
  // would dispose+rebuild the terminal and reconnect the socket).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Recompute the CSS scale that fits the natural (full-size) canvas into the
  // grid cell, preserving aspect ratio and centering. Reads the canvas's
  // *untransformed* offset size (ancestor transforms don't affect it).
  const refit = () => {
    const cell = cellRef.current;
    const scaler = scalerRef.current;
    if (!cell || !scaler) return;
    const canvas = scaler.querySelector('canvas');
    const naturalW = (canvas as HTMLCanvasElement | null)?.offsetWidth ?? scaler.offsetWidth;
    const naturalH = (canvas as HTMLCanvasElement | null)?.offsetHeight ?? scaler.offsetHeight;
    if (!naturalW || !naturalH) return;
    const scale = Math.min(cell.clientWidth / naturalW, cell.clientHeight / naturalH);
    const left = (cell.clientWidth - naturalW * scale) / 2;
    const top = (cell.clientHeight - naturalH * scale) / 2;
    scaler.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  };

  useEffect(() => {
    const scaler = scalerRef.current;
    if (!scaler) return;

    // Mirror is read-only: stdin disabled, no onData/onResize wiring, no focus
    // registry, no store registration. It only ever displays.
    const term = new Terminal({
      ...buildTerminalOptions(config),
      disableStdin: true,
      renderer: 'canvas',
    });
    term.open(scaler);
    termRef.current = term;
    if (!visibleRef.current) term.suspend();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // cols/rows in the query only matter if this mirror is the very first attach
    // to a never-spawned pane (spawns the shell at this size); a real viewer will
    // resize it on switch. The backend never resizes the PTY for a mirror.
    const url = `${protocol}//${window.location.host}/ws/pane/${paneId}?mirror=1&cols=80&rows=24`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'size' && msg.cols > 0 && msg.rows > 0) {
            term.resize(msg.cols, msg.rows);
            // Canvas resizes during the next render; refit after it commits.
            requestAnimationFrame(refit);
          }
        } catch {
          // Non-JSON text (shouldn't happen on a mirror) — treat as output.
          term.write(ev.data);
        }
      }
    };

    // Refit when the emulator repaints (covers the initial render and any reflow)
    // and when the cell changes size (grid resize / window-count change).
    const offRender = term.onRender(() => refit());
    const observer = new ResizeObserver(() => refit());
    if (cellRef.current) observer.observe(cellRef.current);

    return () => {
      offRender.dispose();
      observer.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
    // Rebuild on config/font change so a live theme reload re-themes thumbnails,
    // matching TerminalPane. paneId is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, config]);

  // Park / wake with the grid's visibility (sockets keep streaming either way).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (visible) {
      term.resume();
      requestAnimationFrame(refit);
    } else {
      term.suspend();
    }
  }, [visible]);

  return (
    <div ref={cellRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        ref={scalerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: 'top left',
          // Block the terminal's own input affordances; the grid handles clicks.
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
