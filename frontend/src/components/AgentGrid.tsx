import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from '@astryxdesign/core/Layout';
import { Grid } from '@astryxdesign/core/Grid';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import { Text } from '@astryxdesign/core/Text';
import { Kbd } from '@astryxdesign/core/Kbd';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import type { AgentStatus } from '../state/types';
import { AgentStatusBadge } from './PaneTitleBar';
import { MirrorPane } from './MirrorPane';
import { KeyCap } from './KeyHint';

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

  const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.max(1, Math.ceil(entries.length / cols));
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
      const delta = right ? 1 : left ? -1 : down ? cols : -cols;
      setSelectedIdx((i) => Math.max(0, Math.min(n - 1, i + delta)));
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
              <Text color="secondary">
                No agents detected. Start Claude, Codex, Gemini, Antigravity, or OpenCode in a pane.
              </Text>
            ) : (
              <Grid
                columns={cols}
                gap={3}
                minHeight="100%"
                style={{ gridTemplateRows: `repeat(${rows}, minmax(160px, 1fr))` }}
              >
                {entries.map((entry, i) => {
                  const paneLabel = entry.paneTitle || `pane ${entry.paneIndex + 1}`;
                  return (
                    <SelectableCard
                      key={entry.paneId}
                      label={`${entry.sessionName} › ${entry.windowName} › ${paneLabel}`}
                      isSelected={i === clampedIdx}
                      onChange={() => select(entry)}
                      padding={2}
                      height="100%"
                    >
                      <VStack gap={2} className="h-full min-h-0">
                        <HStack gap={2} vAlign="center" className="min-w-0">
                          {i < 9 && <Kbd keys={String(i + 1)} />}
                          <Text color="secondary">{entry.sessionName}</Text>
                          <Text>{entry.windowName}</Text>
                          <Text color="secondary">{paneLabel}</Text>
                          <HStack className="ml-auto">
                            <AgentStatusBadge status={entry.agentStatus} />
                          </HStack>
                        </HStack>
                        <VStack data-agent-mirror className="relative min-h-0 flex-1 overflow-hidden">
                          {mirrorsReady && <MirrorPane paneId={entry.paneId} visible={open} />}
                        </VStack>
                      </VStack>
                    </SelectableCard>
                  );
                })}
              </Grid>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={4} wrap="wrap">
              {HINTS.map(([keys, label]) => (
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
  [['esc'], 'close'],
];
