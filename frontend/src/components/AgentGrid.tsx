import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  HStack,
  VStack,
} from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Button } from '@astryxdesign/core/Button';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import { Text } from '@astryxdesign/core/Text';
import { Kbd } from '@astryxdesign/core/Kbd';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Bot, Eye, EyeOff, Minus, RotateCcw } from 'lucide-react';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import type { AgentStatus } from '../state/types';
import { AgentStatusBadge } from './PaneTitleBar';
import { MirrorPane } from './MirrorPane';
import { KeyHint } from './KeyHint';
import { usePressHint } from '../hooks/usePressHint';
import { chromePalette } from '../lib/chrome-colors';
import { AgentUsageView } from './AgentUsageView';
import { cycleTabs, enterTabPanel } from '../lib/tabKeys';
import { NARROW_QUERY } from '../lib/touch';

interface Props {
  send: (msg: ClientMessage) => void;
}

const VIEWS = ['panes', 'usage'] as const;
type AgentView = (typeof VIEWS)[number];

/** Keys a focused tab handles itself; the rest still reach the grid. */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']);

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

const paneLabel = (entry: AgentPaneEntry) => entry.paneTitle || `pane ${entry.paneIndex + 1}`;

// Minimized agents, per browser. Pane ids are UUIDs, so stale ids never match.
const MINIMIZED_KEY = 'btmux-minimized-agents';

function loadMinimized(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MINIMIZED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveMinimized(ids: ReadonlySet<string>) {
  try {
    localStorage.setItem(MINIMIZED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage may be unavailable; minimizing still works for this page.
  }
}

const GAP = 12;
const SIDEBAR_WIDTH = 300;
// Per-tile card chrome around the terminal (padding, border, header row).
const CHROME_W = 24;
const CHROME_H = 56;
const FALLBACK_SIZE = { w: 640, h: 400 };
const MIN_SCALE = 0.1;
// How long a mirror may take to report its size before it gets the fallback.
const SIZE_WAIT_MS = 2000;

interface Size {
  w: number;
  h: number;
}

interface Packed {
  /** Entry indices per visual row. */
  lines: number[][];
  /** Terminal box size per entry index; `null` is not laid out yet. */
  sizes: (Size | null)[];
}

/** Flows tiles left to right, wrapping at `width`; returns rows and total height. */
function flow(naturals: (Size | null)[], scale: number, width: number): Packed & { height: number } {
  const sizes = naturals.map((n) => n && { w: n.w * scale, h: n.h * scale });
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  let height = 0;
  let lineH = 0;
  sizes.forEach((size, i) => {
    if (!size) return;
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
function pack(naturals: (Size | null)[], width: number, height: number): Packed {
  const widest = Math.max(1, ...naturals.map((n) => n?.w ?? 0));
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

/** Each tile's own wait for its mirror's size; a stuck mirror can't affect later tiles. */
function SizeDeadline({ paneId, onExpire }: { paneId: string; onExpire: (paneId: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onExpire(paneId), SIZE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [paneId, onExpire]);
  return null;
}

/** Full-screen live mirrors of agent panes, with a sidebar listing every agent. */
export function AgentGrid({ send }: Props) {
  const [view, setView] = useState<AgentView>('panes');
  const open = useStore((s) => s.agentGridOpen);
  const mounted = useStore((s) => s.agentGridMounted);
  const setOpen = useStore((s) => s.setAgentGridOpen);
  const allSessions = useStore((s) => s.allSessions);
  const agentPanes = useStore((s) => s.agentPanes);
  const config = useStore((s) => s.config);
  const location = useLocation();
  const navigate = useNavigate();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const entries = useMemo(() => buildEntries(allSessions, agentPanes), [allSessions, agentPanes]);
  const terminalBg = chromePalette(config?.theme ?? null).bodyBg;

  // Minimized agents stay in the sidebar and drop their mirror.
  const [minimized, setMinimizedState] = useState<ReadonlySet<string>>(loadMinimized);
  const setMinimized = (ids: Iterable<string>) => {
    const panes = new Set(allSessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => p.id))));
    const next = new Set([...ids].filter((id) => panes.has(id)));
    setMinimizedState(next);
    saveMinimized(next);
  };
  const shown = useMemo(() => entries.filter((entry) => !minimized.has(entry.paneId)), [entries, minimized]);

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
  const [naturals, setNaturals] = useState<Record<string, Size>>({});
  const reportSize = useCallback((paneId: string, w: number, h: number) => {
    setNaturals((prev) => {
      const old = prev[paneId];
      return old && old.w === w && old.h === h ? prev : { ...prev, [paneId]: { w, h } };
    });
  }, []);
  // Tiles first appear together, once sized. An agent that starts later (or is
  // restored) joins once sized, so each change of the tile set is one layout change.
  const [timedOutPanes, setTimedOutPanes] = useState<ReadonlySet<string>>(new Set());
  const sizeTimedOut = useCallback((paneId: string) => setTimedOutPanes((prev) => new Set(prev).add(paneId)), []);
  const allSized = shown.every((entry) => naturals[entry.paneId] || timedOutPanes.has(entry.paneId));
  const [tilesShown, setTilesShown] = useState(false);
  useEffect(() => {
    if (open) {
      if (allSized) setTilesShown(true);
    } else {
      setTilesShown(false);
      setTimedOutPanes(new Set());
    }
  }, [open, allSized]);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const areaRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setArea({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(el);
  }, []);
  // Indices in `packed` are into `shown`.
  const packed = useMemo(
    () =>
      area && area.w > 0 && area.h > 0
        ? pack(
            shown.map((entry) => naturals[entry.paneId] ?? (timedOutPanes.has(entry.paneId) ? FALLBACK_SIZE : null)),
            area.w,
            area.h,
          )
        : null,
    [area, shown, naturals, timedOutPanes],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // A synthetic Tab moves no focus, so hints must reach the dialog's handler.
  const focusDialog = useCallback(() => dialogRef.current?.focus(), []);
  const pressHint = usePressHint(dialogRef, focusDialog);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const match = location.pathname.match(/^\/s\/([^/]+)/);
      const sessionName = match ? decodeURIComponent(match[1]) : null;
      const session = sessionName ? allSessions.find((s) => s.name === sessionName) : null;
      const activeWindow = session?.windows[session.active_window];
      const activePaneId = activeWindow?.panes[activeWindow.active_pane]?.id;
      const active = entries.find((entry) => entry.paneId === activePaneId);
      setSelectedId((active ?? shown[0] ?? entries[0])?.paneId ?? null);
    }
    wasOpen.current = open;
  }, [open, entries, shown, location.pathname, allSessions]);

  // Selection is by pane, over all agents; a gone agent falls back to the first.
  const selectedIdx = Math.max(
    0,
    entries.findIndex((entry) => entry.paneId === selectedId),
  );
  const selected = entries[selectedIdx];

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

  const toggleMinimized = (entry: AgentPaneEntry) => {
    const next = new Set(minimized);
    if (!next.delete(entry.paneId)) next.add(entry.paneId);
    setMinimized(next);
  };

  // Shows only this agent; again, shows them all.
  const toggleOnly = (entry: AgentPaneEntry) => {
    const alone = shown.length === 1 && shown[0].paneId === entry.paneId;
    setMinimized(alone ? [] : entries.filter((other) => other !== entry).map((other) => other.paneId));
  };

  const changeView = (value: AgentView) => {
    setView(value);
    // A tab keeping focus would take the grid's keys.
    dialogRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    const n = entries.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (cycleTabs(e, VIEWS, view, changeView)) return;
    if (view !== 'panes') {
      enterTabPanel(e);
      return;
    }
    if (TAB_KEYS.has(e.key) && (e.target as Element).closest('[role="tablist"]')) return;
    if (n === 0 || !selected) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (minimized.has(selected.paneId)) toggleMinimized(selected);
      else select(selected);
      return;
    }
    const right = e.key === 'ArrowRight' || e.key === 'l';
    const left = e.key === 'ArrowLeft' || e.key === 'h';
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (right || left || down || up) {
      e.preventDefault();
      // Arrows move between tiles; from a minimized agent, to the nearest tile.
      const pos = shown.indexOf(selected);
      if (pos < 0) {
        const next =
          entries.slice(selectedIdx + 1).find((entry) => !minimized.has(entry.paneId)) ??
          entries
            .slice(0, selectedIdx)
            .reverse()
            .find((entry) => !minimized.has(entry.paneId));
        if (next) setSelectedId(next.paneId);
        return;
      }
      if (left || right) {
        const next = shown[pos + (right ? 1 : -1)];
        if (next) setSelectedId(next.paneId);
        return;
      }
      const lines = packed?.lines ?? [];
      const li = lines.findIndex((line) => line.includes(pos));
      const target = lines[li + (down ? 1 : -1)];
      if (li < 0 || !target) return;
      const col = lines[li].indexOf(pos);
      setSelectedId(shown[target[Math.min(col, target.length - 1)]].paneId);
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const action = { r: reset, m: toggleMinimized, o: toggleOnly }[e.key];
      if (action) {
        e.preventDefault();
        action(selected);
        return;
      }
    }
    if (e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1;
      if (idx < n) {
        e.preventDefault();
        setSelectedId(entries[idx].paneId);
      }
    }
  };

  if (!mounted) return null;

  const minimizedCount = entries.length - shown.length;
  const sidebar = (
    <List
      density="compact"
      header={
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" hasTabularNumbers>
            {minimizedCount ? `${shown.length} of ${entries.length} shown` : `${entries.length} shown`}
          </Text>
          {minimizedCount > 0 && (
            <Button
              label="Show all"
              variant="ghost"
              size="sm"
              onClick={() => {
                setMinimized([]);
                dialogRef.current?.focus();
              }}
            />
          )}
        </HStack>
      }
    >
      {entries.map((entry, i) => {
        const isMinimized = minimized.has(entry.paneId);
        return (
          <ListItem
            key={entry.paneId}
            data-agent-row={entry.paneId}
            data-minimized={isMinimized || undefined}
            isSelected={entry === selected}
            startContent={
              <Icon
                icon={isMinimized ? EyeOff : Eye}
                size="sm"
                color="secondary"
                label={isMinimized ? 'Minimized' : 'Shown'}
              />
            }
            label={
              <Text maxLines={1} color={isMinimized ? 'secondary' : 'primary'}>
                {paneLabel(entry)}
              </Text>
            }
            description={
              <Text type="supporting" maxLines={1} className="btm-mono">
                {entry.sessionName} › {entry.windowName}
              </Text>
            }
            endContent={
              <HStack gap={1} vAlign="center">
                <AgentStatusBadge status={entry.agentStatus} />
                {i < 9 && <Kbd keys={String(i + 1)} />}
              </HStack>
            }
            // A click toggles; a double click (two toggles) switches to the pane.
            onClick={() => {
              setSelectedId(entry.paneId);
              toggleMinimized(entry);
              // A focused row would take Enter from the grid.
              dialogRef.current?.focus();
            }}
            onDoubleClick={() => select(entry)}
          />
        );
      })}
    </List>
  );

  const tiles = (
    <div
      ref={areaRef}
      data-agent-tiles
      className="flex h-full min-h-0 min-w-0 flex-1 flex-wrap content-center items-center justify-center overflow-auto"
      style={{ gap: GAP, opacity: tilesShown || allSized ? 1 : 0 }}
    >
      {shown.length === 0 && (
        <EmptyState
          icon={<Icon icon={EyeOff} size="lg" color="secondary" />}
          title="All agents minimized"
          description="Click an agent in the list to show it."
        />
      )}
      {packed &&
        shown.map((entry, i) => {
          const number = entries.indexOf(entry);
          const size = packed.sizes[i];
          return (
            <div
              key={entry.paneId}
              // An unsized tile keeps its mirror mounted, which reports the size.
              style={
                size
                  ? { width: size.w + CHROME_W, height: size.h + CHROME_H }
                  : {
                      position: 'absolute',
                      width: FALLBACK_SIZE.w,
                      height: FALLBACK_SIZE.h,
                      opacity: 0,
                      pointerEvents: 'none',
                    }
              }
            >
              <SelectableCard
                label={`${entry.sessionName} › ${entry.windowName} › ${paneLabel(entry)}`}
                isSelected={entry === selected}
                onChange={() => select(entry)}
                padding={2}
                height="100%"
              >
                <VStack gap={2} className="h-full min-h-0">
                  <HStack gap={2} vAlign="center" className="min-w-0">
                    {number < 9 && <Kbd keys={String(number + 1)} />}
                    <Text maxLines={1} className="min-w-0 flex-1">
                      <Text color="secondary" className="btm-mono">
                        {entry.sessionName}
                      </Text>{' '}
                      <Text className="btm-mono">{entry.windowName}</Text>{' '}
                      <Text color="secondary">{paneLabel(entry)}</Text>
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
                          // A focused button would keep Tab inside the panel.
                          dialogRef.current?.focus();
                        }}
                      />
                      <IconButton
                        label="Minimize"
                        icon={<Minus />}
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleMinimized(entry);
                          dialogRef.current?.focus();
                        }}
                      />
                    </HStack>
                  </HStack>
                  <VStack
                    data-agent-mirror
                    className="relative min-h-0 flex-1 overflow-hidden"
                    style={{ background: terminalBg }}
                  >
                    {/* Only while shown: a hidden mirror can't report its size, and closing clears expiries. */}
                    {open && view === 'panes' && !naturals[entry.paneId] && (
                      <SizeDeadline paneId={entry.paneId} onExpire={sizeTimedOut} />
                    )}
                    {mirrorsReady && (
                      <MirrorPane
                        paneId={entry.paneId}
                        visible={open && view === 'panes'}
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
  );

  const hasSidebar = view === 'panes' && entries.length > 0;

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
          <>
            <DialogHeader
              title="Agents"
              onOpenChange={(value) => {
                if (!value) cancel();
              }}
            />
            <LayoutHeader paddingBlockEnd={0}>
              <TabList
                value={view}
                onChange={(value) => changeView(value as AgentView)}
                role="tablist"
                hasDivider
                isFullBleed
              >
                <Tab value="panes" label="Live panes" panelId="agents-panes" />
                <Tab value="usage" label="Usage" panelId="agents-usage" />
              </TabList>
            </LayoutHeader>
          </>
        }
        start={
          hasSidebar && !isNarrow ? (
            <LayoutPanel width={SIDEBAR_WIDTH} hasDivider padding={2} label="Agent list">
              {sidebar}
            </LayoutPanel>
          ) : undefined
        }
        content={
          <LayoutContent padding={4}>
            <VStack
              id="agents-panes"
              role="tabpanel"
              aria-label="Live panes"
              gap={2}
              className={view === 'panes' ? 'h-full min-h-0' : 'hidden'}
            >
              {entries.length === 0 ? (
                <VStack hAlign="center" vAlign="center" className="h-full">
                  <EmptyState
                    icon={<Icon icon={Bot} size="lg" color="secondary" />}
                    title="No agents detected"
                    description="Start Claude Code, Codex, Gemini, Antigravity, or OpenCode in a pane."
                  />
                </VStack>
              ) : (
                <>
                  {/* Narrow screens stack the list above the tiles. */}
                  {isNarrow && <VStack className="max-h-1/3 shrink-0 overflow-auto">{sidebar}</VStack>}
                  {tiles}
                </>
              )}
            </VStack>
            {view === 'usage' && open && (
              <VStack id="agents-usage" role="tabpanel" aria-label="Usage" className="h-full">
                <AgentUsageView />
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={4} wrap="wrap">
              {(view === 'panes' && entries.length ? HINTS : CLOSE_HINTS).map(([keys, label]) => (
                <KeyHint key={label} keys={keys} label={label} onPress={pressHint} />
              ))}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

const HINTS: [string[], string][] = [
  [['tab'], 'next tab'],
  [['up', 'down', 'left', 'right'], 'navigate'],
  [['1', '9'], 'select agent'],
  [['enter'], 'switch'],
  [['m'], 'minimize'],
  [['o'], 'only'],
  [['r'], 'reset agent state'],
  [['esc'], 'close'],
];

const CLOSE_HINTS: [string[], string][] = [
  [['tab'], 'next tab'],
  [['esc'], 'close'],
];
