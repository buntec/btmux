import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Button } from '@astryxdesign/core/Button';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { KeyCap } from './KeyHint';
import { HStack } from '@astryxdesign/core/Layout';
import { Activity, FolderOpen, GitBranch } from 'lucide-react';
import { useStore, type FileBrowserMode } from '../state/store';
import { chromePalette } from '../lib/chrome-colors';
import { sortWindows, WINDOW_MRU_EVENT } from '../state/windowMru';
import { getAnimations, getWindowSort } from '../state/configDefaults';
import { openFileBrowserFiles } from '../lib/openFileBrowserFiles';
import type { ClientMessage } from '../protocol/messages';
import { SysStatBar } from './SysStatBar';

let mruVersion = 0;
window.addEventListener(WINDOW_MRU_EVENT, () => mruVersion++);

export function StatusBar({ sessionId, send }: { sessionId: string; send: (message: ClientMessage) => void }) {
  const sessions = useStore((state) => state.allSessions);
  const config = useStore((state) => state.config);
  const notifications = useStore((state) => state.notifications);
  const prefixActive = useStore((state) => state.prefixActive);
  const navigate = useNavigate();
  useSyncExternalStore(
    (callback) => {
      window.addEventListener(WINDOW_MRU_EVENT, callback);
      return () => window.removeEventListener(WINDOW_MRU_EVENT, callback);
    },
    () => mruVersion,
  );
  const session = sessions.find((session) => session.id === sessionId);
  if (!session) return null;
  const activeWindow = session.windows[session.active_window];
  const pane = activeWindow?.panes[activeWindow.active_pane];
  const state = useStore.getState;
  const openFiles = (mode: FileBrowserMode) => {
    if (!pane) return;
    state().setOverlay(null);
    state().setSettingsOpen(false);
    state().setSwitcherOpen(false);
    state().setWindowGridOpen(false);
    state().setAgentGridOpen(false);
    if (mode === 'files') void openFileBrowserFiles(pane.id, pane.cwd ?? null);
    else state().setFileBrowserOpen(true, pane.cwd ?? null, pane.id, mode);
  };
  return (
    <HStack gap={2} paddingInline={2} vAlign="center" className="min-w-0" role="toolbar" aria-label="Terminal controls">
      <Button label={session.name} variant="ghost" size="sm" onClick={() => state().setSwitcherOpen(true)} />
      <TabList
        value={activeWindow?.id ?? ''}
        onChange={(id) => {
          const index = session.windows.findIndex((item) => item.id === id);
          if (index < 0) return;
          state().setSettingsOpen(false);
          send({ type: 'switch_window', session_id: session.id, index });
          navigate(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(session.windows[index].name)}`);
        }}
        size="sm"
        className="min-w-0 flex-1"
      >
        {sortWindows(session.windows, getWindowSort(config)).map(({ win, index }) => {
          const notification = win.panes
            .map((pane) => notifications.get(pane.id))
            .filter((item) => item != null)
            .sort(
              (a, b) =>
                ['error', 'attention', 'success', 'info'].indexOf(a.level) -
                ['error', 'attention', 'success', 'info'].indexOf(b.level),
            )[0];
          const agent = [...win.panes].sort(
            (a, b) =>
              ['blocked', 'working', 'done', 'idle', 'unknown'].indexOf(a.agent_status.state) -
              ['blocked', 'working', 'done', 'idle', 'unknown'].indexOf(b.agent_status.state),
          )[0];
          const level =
            notification?.level ??
            (agent?.agent_status.state === 'blocked'
              ? 'attention'
              : agent?.agent_status.state === 'working'
                ? 'info'
                : agent?.agent_status.state === 'done'
                  ? 'success'
                  : null);
          return (
            <Tab
              key={win.id}
              value={win.id}
              label={`${index} · ${win.name}${win.zoomed_pane ? ' ⛶' : ''}`}
              endContent={
                level ? (
                  <StatusDot
                    label={notification?.body ?? `Agent ${agent?.agent_status.state}`}
                    variant={level === 'attention' ? 'warning' : level === 'info' ? 'accent' : level}
                  />
                ) : undefined
              }
            />
          );
        })}
      </TabList>
      {prefixActive && <KeyCap keys={config?.prefix ?? 'C-b'} />}
      <HStack gap={1} className="hidden lg:flex">
        <SysStatBar c={chromePalette(config?.theme ?? null)} barH={28} font={12} animations={getAnimations(config)} />
      </HStack>
      <IconButton
        label="File browser"
        tooltip="File browser"
        variant="ghost"
        size="sm"
        icon={<FolderOpen />}
        onClick={() => openFiles('files')}
      />
      <IconButton
        label="Git mode"
        tooltip="Git mode"
        variant="ghost"
        size="sm"
        icon={<GitBranch />}
        onClick={() => openFiles('git')}
      />
      <IconButton
        label="Process viewer"
        tooltip="Process viewer"
        variant="ghost"
        size="sm"
        icon={<Activity />}
        onClick={() => openFiles('process')}
      />
    </HStack>
  );
}
