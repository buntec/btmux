import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from '@astryxdesign/core/Layout';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import { Text } from '@astryxdesign/core/Text';
import { Kbd } from '@astryxdesign/core/Kbd';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Bot, RotateCcw } from 'lucide-react';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import type { AgentStatus } from '../state/types';
import { AgentStatusBadge } from './PaneTitleBar';
import { MirrorPane } from './MirrorPane';
import { KeyCap } from './KeyHint';
import { chromePalette } from '../lib/chrome-colors';
import { getAnimations } from '../state/configDefaults';
import { getAgentGridOrder, moveId, saveAgentGridOrder, sortByAgentGridOrder } from '../state/agentGridOrder';

interface Props {
  send: (msg: ClientMessage) => void;
}

interface AgentPaneEntry {
  sessionId: string;
  sessionName: string;
  windowName: string;
  windowIndex: number;
  paneId: string;
  paneIndex: number;
  paneTitle: string | null;
  agentStatus: AgentStatus;
}

function buildEntries(
  allSessions: ReturnType<typeof useStore.getState>['allSessions'],
  activePaneIds: Set<string>,
): AgentPaneEntry[] {
  const entries: AgentPaneEntry[] = [];
  for (const session of allSessions) {
    session.windows.forEach((win, windowIndex) => {
      win.panes.forEach((pane, paneIndex) => {
        if (!activePaneIds.has(pane.id)) return;
        entries.push({
          sessionId: session.id,
          sessionName: session.name,
          windowName: win.name,
          windowIndex,
          paneId: pane.id,
          paneIndex,
          paneTitle: pane.title,
          agentStatus: pane.agent_status,
        });
      });
    });
  }
  return entries;
}

const GAP = 12;
// Per-tile card chrome around the terminal (padding, border, header row).
const CHROME_W = 24;
const CHROME_H = 56;
const FALLBACK_SIZE = { w: 640, h: 400 };
const MIN_SCALE = 0.1;
// Pointer travel (px) before a press becomes a drag.
const DRAG_THRESHOLD = 5;
const SLIDE: KeyframeAnimationOptions = { duration: 150, easing: 'ease-out' };

interface DragState {
  paneId: string;
  /** Pointer position in the grid's content coordinates. */
  x: number;
  y: number;
  /** Pointer offset from the tile's top left corner. */
  grabX: number;
  grabY: number;
  /** Order and slot centers when the drag started. */
  ids: string[];
  slots: { x: number; y: number }[];
  order: string[];
}

/** Animates `el` from an offset of (dx, dy) back to its layout position. */
function slide(el: HTMLElement, dx: number, dy: number) {
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], SLIDE);
}

interface Packed {
  /** Entry indices per visual row. */
  lines: number[][];
  /** Terminal box size per entry index. */
  sizes: { w: number; h: number }[];
}

/** Flows tiles left to right, wrapping at `width`; returns rows and total height. */
function flow(naturals: { w: number; h: number }[], scale: number, width: number): Packed & { height: number } {
  const sizes = naturals.map((n) => ({ w: n.w * scale, h: n.h * scale }));
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  let height = 0;
  let lineH = 0;
  sizes.forEach((size, i) => {
    const tileW = size.w + CHROME_W;
    if (line.length && used + GAP + tileW > width) {
      lines.push(line);
      height += lineH + GAP;
      line = [];
      used = 0;
      lineH = 0;
    }
    used += (line.length ? GAP : 0) + tileW;
    lineH = Math.max(lineH, size.h + CHROME_H);
    line.push(i);
  });
  if (line.length) {
    lines.push(line);
    height += lineH;
  }
  return { lines, sizes, height };
}

/** Largest shared scale (at most 1:1) at which all tiles fit without scrolling. */
function pack(naturals: { w: number; h: number }[], width: number, height: number): Packed {
  const widest = Math.max(1, ...naturals.map((n) => n.w));
  let lo = MIN_SCALE;
  let hi = Math.max(MIN_SCALE, Math.min(1, (width - CHROME_W) / widest));
  if (flow(naturals, hi, width).height <= height) return flow(naturals, hi, width);
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (flow(naturals, mid, width).height <= height) lo = mid;
    else hi = mid;
  }
  return flow(naturals, lo, width);
}

/** Full-screen live mirrors of panes with detected or reported agents. */
export function AgentGrid({ send }: Props) {
  const open = useStore((s) => s.agentGridOpen);
  const mounted = useStore((s) => s.agentGridMounted);
  const setOpen = useStore((s) => s.setAgentGridOpen);
  const allSessions = useStore((s) => s.allSessions);
  const agentPanes = useStore((s) => s.agentPanes);
  const config = useStore((s) => s.config);
  const location = useLocation();
  const navigate = useNavigate();
  // Dragging previews `dragOrder`; dropping saves it as `order`.
  const [order, setOrder] = useState(getAgentGridOrder);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const entries = useMemo(
    () => sortByAgentGridOrder(buildEntries(allSessions, agentPanes), (entry) => entry.paneId, dragOrder ?? order),
    [allSessions, agentPanes, order, dragOrder],
  );
  const terminalBg = chromePalette(config?.theme ?? null).bodyBg;

  const [mirrorsReady, setMirrorsReady] = useState(false);
  const hasEverBeenReady = useRef(false);
  useEffect(() => {
    if (open && !hasEverBeenReady.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMirrorsReady(true);
          hasEverBeenReady.current = true;
        });
      });
    }
  }, [open]);

  // Tiles are each terminal's natural size times one shared scale, so fonts
  // match across tiles (a mirror can't change the PTY size).
  const [naturals, setNaturals] = useState<Record<string, { w: number; h: number }>>({});
  const reportSize = useCallback((paneId: string, w: number, h: number) => {
    setNaturals((prev) => {
      const old = prev[paneId];
      return old && old.w === w && old.h === h ? prev : { ...prev, [paneId]: { w, h } };
    });
  }, []);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const areaElRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    areaElRef.current = el;
    if (!el) return;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(el);
  }, []);
  const packed = useMemo(
    () =>
      area && area.w > 0 && area.h > 0
        ? pack(
            entries.map((entry) => naturals[entry.paneId] ?? FALLBACK_SIZE),
            area.w,
            area.h,
          )
        : null,
    [area, entries, naturals],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const match = location.pathname.match(/^\/s\/([^/]+)/);
      const sessionName = match ? decodeURIComponent(match[1]) : null;
      const session = sessionName ? allSessions.find((s) => s.name === sessionName) : null;
      const activeWindow = session?.windows[session.active_window];
      const activePaneId = activeWindow?.panes[activeWindow.active_pane]?.id;
      const idx = activePaneId ? entries.findIndex((entry) => entry.paneId === activePaneId) : -1;
      setSelectedIdx(idx >= 0 ? idx : 0);
    }
    wasOpen.current = open;
  }, [open, entries, location.pathname, allSessions]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, entries.length - 1));

  // SessionPane refocuses the active pane on close.
  const cancel = () => setOpen(false);

  const select = (entry: AgentPaneEntry | undefined) => {
    if (!entry) return;
    send({ type: 'switch_window', session_id: entry.sessionId, index: entry.windowIndex });
    send({ type: 'select_pane', session_id: entry.sessionId, pane_id: entry.paneId });
    const session = allSessions.find((item) => item.id === entry.sessionId);
    navigate(`/s/${encodeURIComponent(session?.name ?? entry.sessionName)}/w/${encodeURIComponent(entry.windowName)}`);
    setOpen(false);
  };

  const reset = (entry: AgentPaneEntry | undefined) => {
    if (entry) send({ type: 'reset_agent', pane_id: entry.paneId });
  };

  const moveTile = (from: number, to: number) => {
    setOrder(
      saveAgentGridOrder(
        moveId(
          entries.map((entry) => entry.paneId),
          from,
          to,
        ),
      ),
    );
    setSelectedIdx(to);
  };

  // Drag to reorder: the tile follows the pointer and the others reflow around
  // the slot nearest its center. Window listeners, not pointer capture, since
  // React may move the tile's node while it reorders.
  const tileEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const stopDragRef = useRef<((commit: boolean) => void) | null>(null);
  const dropRef = useRef<{ paneId: string; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const contentPoint = (e: Pick<PointerEvent, 'clientX' | 'clientY'>) => {
    const area = areaElRef.current;
    if (!area) return null;
    const rect = area.getBoundingClientRect();
    return { x: e.clientX - rect.left + area.scrollLeft, y: e.clientY - rect.top + area.scrollTop };
  };

  // The dragged tile's top left, kept inside the visible grid: past its edge
  // the tile would add scroll overflow, and scrollbars would repack the tiles.
  // 1px covers offset rounding of fractional tile boxes.
  const dragOrigin = (drag: DragState, el: HTMLElement) => {
    const area = areaElRef.current;
    const x = drag.x - drag.grabX;
    const y = drag.y - drag.grabY;
    if (!area) return { x, y };
    return {
      x: Math.max(area.scrollLeft, Math.min(x, area.scrollLeft + area.clientWidth - el.offsetWidth - 1)),
      y: Math.max(area.scrollTop, Math.min(y, area.scrollTop + area.clientHeight - el.offsetHeight - 1)),
    };
  };

  const placeDragged = () => {
    const drag = dragRef.current;
    const el = drag && tileEls.current.get(drag.paneId);
    if (!drag || !el) return;
    const origin = dragOrigin(drag, el);
    el.style.transform = `translate(${origin.x - el.offsetLeft}px, ${origin.y - el.offsetTop}px)`;
  };

  const startDrag = (paneId: string, e: PointerEvent, grab: { x: number; y: number }): DragState | null => {
    const el = tileEls.current.get(paneId);
    const point = contentPoint(e);
    if (!el || !point) return null;
    const ids = entries.map((entry) => entry.paneId);
    const slots = ids.map((id) => {
      const tile = tileEls.current.get(id);
      return tile
        ? { x: tile.offsetLeft + tile.offsetWidth / 2, y: tile.offsetTop + tile.offsetHeight / 2 }
        : { x: Infinity, y: Infinity };
    });
    window.getSelection()?.removeAllRanges();
    const drag = {
      paneId,
      ...point,
      grabX: grab.x,
      grabY: grab.y,
      ids,
      slots,
      order: ids,
    };
    dragRef.current = drag;
    setDragId(paneId);
    setSelectedIdx(ids.indexOf(paneId));
    return drag;
  };

  const dragTo = (drag: DragState, e: PointerEvent) => {
    const point = contentPoint(e);
    const el = tileEls.current.get(drag.paneId);
    if (!point || !el) return;
    drag.x = point.x;
    drag.y = point.y;
    placeDragged();
    const origin = dragOrigin(drag, el);
    const cx = origin.x + el.offsetWidth / 2;
    const cy = origin.y + el.offsetHeight / 2;
    let target = 0;
    drag.slots.forEach((slot, i) => {
      const best = drag.slots[target];
      if (Math.hypot(slot.x - cx, slot.y - cy) < Math.hypot(best.x - cx, best.y - cy)) target = i;
    });
    const next = moveId(drag.ids, drag.ids.indexOf(drag.paneId), target);
    if (next.some((id, i) => id !== drag.order[i])) {
      drag.order = next;
      setDragOrder(next);
      setSelectedIdx(target);
    }
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const el = tileEls.current.get(drag.paneId);
    if (el) dropRef.current = { paneId: drag.paneId, ...dragOrigin(drag, el) };
    // Escape can cancel before the pointer is released.
    suppressClickRef.current = true;
    setDragId(null);
    setDragOrder(null);
    if (commit) setOrder(saveAgentGridOrder(drag.order));
    setSelectedIdx((commit ? drag.order : drag.ids).indexOf(drag.paneId));
  };

  const onTilePointerDown = (paneId: string, e: React.PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || entries.length < 2 || stopDragRef.current) return;
    if ((e.target as Element).closest('button')) return;
    const el = tileEls.current.get(paneId);
    const point = contentPoint(e);
    if (!el || !point) return;
    const grab = { x: point.x - el.offsetLeft, y: point.y - el.offsetTop };
    const { pointerId, clientX, clientY } = e;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // The release went elsewhere (e.g. another window).
      if (ev.buttons === 0) return stop(false);
      let drag = dragRef.current;
      if (!drag) {
        if (Math.hypot(ev.clientX - clientX, ev.clientY - clientY) < DRAG_THRESHOLD) return;
        drag = startDrag(paneId, ev, grab);
        if (!drag) return stop(false);
      }
      ev.preventDefault();
      dragTo(drag, ev);
    };
    const up = (ev: PointerEvent) => ev.pointerId === pointerId && stop(true);
    const cancel = (ev: PointerEvent) => ev.pointerId === pointerId && stop(false);
    const blur = () => stop(false);
    const stop = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      stopDragRef.current = null;
      endDrag(commit);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    stopDragRef.current = stop;
  };

  // Cancel a drag when the grid closes or the dragged agent goes away.
  useEffect(() => {
    if (dragId && (!open || !entries.some((entry) => entry.paneId === dragId))) stopDragRef.current?.(false);
  }, [open, entries, dragId]);
  useEffect(() => () => stopDragRef.current?.(false), []);

  // Slide reordered tiles (FLIP) and the dropped tile into their slots.
  const animations = getAnimations(config);
  const orderKey = entries.map((entry) => entry.paneId).join('\n');
  const lastLayout = useRef({ orderKey, pos: new Map<string, { x: number; y: number }>() });
  useLayoutEffect(() => {
    const prev = lastLayout.current;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [id, el] of tileEls.current) pos.set(id, { x: el.offsetLeft, y: el.offsetTop });
    lastLayout.current = { orderKey, pos };
    placeDragged();
    const drop = dropRef.current;
    dropRef.current = null;
    const dropped = drop && tileEls.current.get(drop.paneId);
    if (dropped) {
      dropped.style.transform = '';
      if (animations) slide(dropped, drop.x - dropped.offsetLeft, drop.y - dropped.offsetTop);
    }
    const reordered =
      prev.orderKey !== orderKey && prev.pos.size === pos.size && [...pos.keys()].every((id) => prev.pos.has(id));
    if (!animations || !reordered) return;
    for (const [id, el] of tileEls.current) {
      const from = prev.pos.get(id);
      const to = pos.get(id);
      if (id === dragRef.current?.paneId || id === drop?.paneId || !from || !to) continue;
      if (from.x !== to.x || from.y !== to.y) slide(el, from.x - to.x, from.y - to.y);
    }
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (dragRef.current) {
      e.preventDefault();
      if (e.key === 'Escape') stopDragRef.current?.(false);
      return;
    }
    const n = entries.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (n === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      select(entries[clampedIdx]);
      return;
    }
    // Shift moves the selected tile instead of the selection.
    const key = e.shiftKey && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const right = key === 'ArrowRight' || key === 'l';
    const left = key === 'ArrowLeft' || key === 'h';
    const down = key === 'ArrowDown' || key === 'j';
    const up = key === 'ArrowUp' || key === 'k';
    if (right || left || down || up) {
      e.preventDefault();
      let to: number;
      if (left || right) {
        to = Math.max(0, Math.min(n - 1, clampedIdx + (right ? 1 : -1)));
      } else {
        const lines = packed?.lines ?? [];
        const li = lines.findIndex((line) => line.includes(clampedIdx));
        const target = lines[li + (down ? 1 : -1)];
        if (li < 0 || !target) return;
        to = target[Math.min(lines[li].indexOf(clampedIdx), target.length - 1)];
      }
      if (!e.shiftKey) setSelectedIdx(to);
      else if (to !== clampedIdx) moveTile(clampedIdx, to);
      return;
    }
    if (e.key === 'x') {
      e.preventDefault();
      reset(entries[clampedIdx]);
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1;
      if (idx < n) {
        e.preventDefault();
        setSelectedIdx(idx);
      }
    }
  };

  if (!mounted) return null;

  return (
    <Dialog
      ref={dialogRef}
      tabIndex={-1}
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) cancel();
      }}
      variant="fullscreen"
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => {
        suppressClickRef.current = false;
      }}
      onClickCapture={(e) => {
        if (!suppressClickRef.current || e.detail === 0) return;
        suppressClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onFocus={(e) => {
        // MirrorPane's Terminal.open() focuses its textarea; keep keys on the dialog.
        if ((e.target as Element).closest('[data-agent-mirror]')) dialogRef.current?.focus();
      }}
    >
      <Layout
        header={
          <DialogHeader
            title="Agents"
            onOpenChange={(value) => {
              if (!value) cancel();
            }}
          />
        }
        content={
          <LayoutContent padding={4}>
            {entries.length === 0 ? (
              <VStack hAlign="center" vAlign="center" className="h-full">
                <EmptyState
                  icon={<Icon icon={Bot} size="lg" color="secondary" />}
                  title="No agents detected"
                  description="Start Claude, Codex, Gemini, Antigravity, or OpenCode in a pane."
                />
              </VStack>
            ) : (
              <div
                ref={areaRef}
                className={`relative flex h-full min-h-0 flex-wrap content-center items-center justify-center overflow-auto${dragId ? ' select-none' : ''}`}
                style={{ gap: GAP }}
              >
                {packed &&
                  entries.map((entry, i) => {
                    const paneLabel = entry.paneTitle || `pane ${entry.paneIndex + 1}`;
                    const size = packed.sizes[i];
                    return (
                      <div
                        key={entry.paneId}
                        data-agent-tile={entry.paneId}
                        ref={(el) => {
                          if (!el) return;
                          tileEls.current.set(entry.paneId, el);
                          return () => {
                            tileEls.current.delete(entry.paneId);
                          };
                        }}
                        className={`touch-none **:touch-none ${entry.paneId === dragId ? 'relative z-10' : ''}`}
                        style={{ width: size.w + CHROME_W, height: size.h + CHROME_H }}
                        onPointerDown={(e) => onTilePointerDown(entry.paneId, e)}
                      >
                        <SelectableCard
                          label={`${entry.sessionName} › ${entry.windowName} › ${paneLabel}`}
                          isSelected={i === clampedIdx}
                          onChange={() => select(entry)}
                          padding={2}
                          height="100%"
                        >
                          <VStack gap={2} className="h-full min-h-0">
                            <HStack gap={2} vAlign="center" className="min-w-0">
                              {i < 9 && <Kbd keys={String(i + 1)} />}
                              <Text maxLines={1} className="min-w-0 flex-1">
                                <Text color="secondary">{entry.sessionName}</Text> <Text>{entry.windowName}</Text>{' '}
                                <Text color="secondary">{paneLabel}</Text>
                              </Text>
                              <HStack gap={1} vAlign="center" className="shrink-0">
                                <AgentStatusBadge status={entry.agentStatus} />
                                <IconButton
                                  label="Reset agent state"
                                  icon={<RotateCcw />}
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    reset(entry);
                                  }}
                                />
                              </HStack>
                            </HStack>
                            <VStack
                              data-agent-mirror
                              className="relative min-h-0 flex-1 overflow-hidden"
                              style={{ background: terminalBg }}
                            >
                              {mirrorsReady && (
                                <MirrorPane
                                  paneId={entry.paneId}
                                  visible={open}
                                  onNaturalSize={(w, h) => reportSize(entry.paneId, w, h)}
                                />
                              )}
                            </VStack>
                          </VStack>
                        </SelectableCard>
                      </div>
                    );
                  })}
              </div>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={4} wrap="wrap">
              {(entries.length ? HINTS : CLOSE_HINTS).map(([keys, label]) => (
                <HStack key={label} gap={1} vAlign="center">
                  {keys.map((key) => (
                    <KeyCap key={key} keys={key} />
                  ))}
                  <Text color="secondary">{label}</Text>
                </HStack>
              ))}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

const HINTS: [string[], string][] = [
  [['up', 'down', 'left', 'right'], 'move'],
  [['1', '9'], 'jump to cell'],
  [['shift', 'up', 'down', 'left', 'right'], 'reorder (or drag)'],
  [['enter'], 'switch'],
  [['x'], 'reset agent state'],
  [['esc'], 'close'],
];

const CLOSE_HINTS: [string[], string][] = [[['esc'], 'close']];
