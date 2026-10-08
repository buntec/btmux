import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const entries = useMemo(() => buildEntries(allSessions, agentPanes), [allSessions, agentPanes]);
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
  const areaRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
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

  // The native dialog restores focus to the pane on close.
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
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
    const right = e.key === 'ArrowRight' || e.key === 'l';
    const left = e.key === 'ArrowLeft' || e.key === 'h';
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (right || left || down || up) {
      e.preventDefault();
      if (left || right) {
        setSelectedIdx(Math.max(0, Math.min(n - 1, clampedIdx + (right ? 1 : -1))));
        return;
      }
      const lines = packed?.lines ?? [];
      const li = lines.findIndex((line) => line.includes(clampedIdx));
      const target = lines[li + (down ? 1 : -1)];
      if (li < 0 || !target) return;
      const pos = lines[li].indexOf(clampedIdx);
      setSelectedIdx(target[Math.min(pos, target.length - 1)]);
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
                className="flex h-full min-h-0 flex-wrap content-center items-center justify-center overflow-auto"
                style={{ gap: GAP }}
              >
                {packed &&
                  entries.map((entry, i) => {
                    const paneLabel = entry.paneTitle || `pane ${entry.paneIndex + 1}`;
                    const size = packed.sizes[i];
                    return (
                      <div key={entry.paneId} style={{ width: size.w + CHROME_W, height: size.h + CHROME_H }}>
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
  [['enter'], 'switch'],
  [['x'], 'reset agent state'],
  [['esc'], 'close'],
];

const CLOSE_HINTS: [string[], string][] = [[['esc'], 'close']];
