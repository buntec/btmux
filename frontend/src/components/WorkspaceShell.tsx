import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@astryxdesign/core/AppShell';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Command, Plus, Search, Settings2, Keyboard, Info, Grid2X2, Zap, ZapOff } from 'lucide-react';
import { useStore } from '../state/store';
import { sortSessions, SESSION_MRU_EVENT } from '../state/sessionMru';
import { sortWindows, WINDOW_MRU_EVENT } from '../state/windowMru';
import { getAnimations, getSessionSort, getWindowSort } from '../state/configDefaults';
import { SessionNavItem } from './SessionNavItem';
import { AgentNavItem } from './AgentNavItem';
import { APPEARANCES } from '../lib/appearance';
import type { ClientMessage } from '../protocol/messages';

let mruVersion = 0;
for (const event of [SESSION_MRU_EVENT, WINDOW_MRU_EVENT]) window.addEventListener(event, () => mruVersion++);

export function WorkspaceShell({ children, send }: { children: ReactNode; send: (message: ClientMessage) => void }) {
  const sessions = useStore((state) => state.allSessions);
  const config = useStore((state) => state.config);
  const setOverlay = useStore((state) => state.setOverlay);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const setSwitcherOpen = useStore((state) => state.setSwitcherOpen);
  const setWindowGridOpen = useStore((state) => state.setWindowGridOpen);
  const setAgentGridOpen = useStore((state) => state.setAgentGridOpen);
  const location = useLocation();
  const navigate = useNavigate();
  useSyncExternalStore(
    (callback) => {
      window.addEventListener(SESSION_MRU_EVENT, callback);
      window.addEventListener(WINDOW_MRU_EVENT, callback);
      return () => {
        window.removeEventListener(SESSION_MRU_EVENT, callback);
        window.removeEventListener(WINDOW_MRU_EVENT, callback);
      };
    },
    () => mruVersion,
  );
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('btmux-nav-collapsed') !== 'false';
    } catch {
      return true;
    }
  });
  const currentName = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
  const active = sessions.find((session) => session.name === (currentName ? decodeURIComponent(currentName) : null));
  const closeSurfaces = () => {
    const state = useStore.getState();
    state.setOverlay(null);
    state.setSettingsOpen(false);
    state.setSwitcherOpen(false);
    state.setWindowGridOpen(false);
    state.setAgentGridOpen(false);
    state.setFileBrowserOpen(false);
  };
  const appearanceIndex = Math.max(
    0,
    APPEARANCES.findIndex(({ value }) => value === (config?.appearance ?? 'auto')),
  );
  const appearance = APPEARANCES[appearanceIndex];
  const nextAppearance = APPEARANCES[(appearanceIndex + 1) % APPEARANCES.length];
  const animations = getAnimations(config);
  const newSession = () => {
    closeSurfaces();
    setOverlay({ mode: 'prompt', title: 'New session', value: '', action: 'new-session' });
  };
  return (
    <AppShell
      height="fill"
      // Fill's 100dvh ignores the iOS keyboard; useVisualViewport tracks it.
      style={{ height: 'var(--btm-viewport-height, 100dvh)' }}
      contentPadding={0}
      variant="section"
      // Never scroll the main region: TabList's indicator bleed pokes 1px past
      // the status bar, which shows a scrollbar where scrollbars are classic.
      className="isolate bg-transparent [&_#astryx-app-shell-main]:overflow-clip"
      sideNav={
        <SideNav
          aria-label="Sessions and windows"
          className="btm-side-nav backdrop-blur-2xl"
          collapsible={{
            isCollapsed: collapsed,
            onCollapsedChange: (value) => {
              setCollapsed(value);
              try {
                localStorage.setItem('btmux-nav-collapsed', String(value));
              } catch {}
            },
          }}
          // Collapsed, the iconless heading renders nothing but SideNav would still pad it.
          header={collapsed ? undefined : <SideNavHeading heading="btmux" className="btm-brand" />}
          footerIcons={
            <>
              <IconButton
                label={`Appearance: ${appearance.label}`}
                tooltip={`Appearance: ${appearance.label}`}
                variant="ghost"
                icon={<appearance.icon />}
                onClick={() => send({ type: 'update_config', update: { appearance: nextAppearance.value } })}
              />
              <IconButton
                label={animations ? 'Pause animations' : 'Resume animations'}
                tooltip={animations ? 'Pause animations (saves battery)' : 'Resume animations'}
                variant="ghost"
                icon={animations ? <Zap /> : <ZapOff />}
                onClick={() => send({ type: 'update_config', update: { animations: !animations } })}
              />
              <IconButton
                label="Settings"
                tooltip="Settings"
                variant="ghost"
                icon={<Settings2 />}
                onClick={() => {
                  closeSurfaces();
                  setSettingsOpen(true);
                }}
              />
              <IconButton
                label="Key bindings"
                tooltip="Key bindings"
                variant="ghost"
                icon={<Keyboard />}
                onClick={() => {
                  closeSurfaces();
                  setOverlay({ mode: 'keys', title: 'Key bindings', binds: config?.binds ?? [] });
                }}
              />
              <IconButton
                label="About btmux"
                tooltip="About btmux"
                variant="ghost"
                icon={<Info />}
                onClick={() => {
                  closeSurfaces();
                  setOverlay({ mode: 'info', title: 'About btmux' });
                }}
              />
            </>
          }
        >
          <SideNavSection title="Workspace">
            <SideNavItem
              label="Switch session"
              icon={Search}
              onClick={() => {
                closeSurfaces();
                setSwitcherOpen(true);
              }}
            />
            {active && (
              <SideNavItem
                label="Window overview"
                icon={Grid2X2}
                onClick={() => {
                  closeSurfaces();
                  setWindowGridOpen(true);
                }}
              />
            )}
            <AgentNavItem
              collapsed={collapsed}
              onClick={() => {
                closeSurfaces();
                setAgentGridOpen(true);
              }}
            />
            <SideNavItem
              label="Commands"
              icon={Command}
              onClick={() => {
                closeSurfaces();
                setOverlay({ mode: 'command', title: 'Commands', commands: config?.commands ?? [] });
              }}
            />
          </SideNavSection>
          <SideNavSection
            title="Sessions"
            // The collapsed rail clips endContent; it gets a nav item below instead.
            endContent={
              collapsed ? undefined : (
                <IconButton
                  label="New session"
                  tooltip="New session"
                  variant="ghost"
                  size="sm"
                  icon={<Plus />}
                  onClick={newSession}
                />
              )
            }
          >
            {/* Session and window names are identifiers. */}
            <div className="btm-mono contents">
              {sortSessions(sessions, getSessionSort(config)).map((session) => (
                <SessionNavItem
                  key={session.id}
                  session={session}
                  collapsed={collapsed}
                  isSelected={session.id === active?.id}
                  onClick={() => {
                    closeSurfaces();
                    navigate(`/s/${encodeURIComponent(session.name)}`);
                  }}
                >
                  {sortWindows(session.windows, getWindowSort(config)).map(({ win, index }, displayIndex) => (
                    <SideNavItem
                      key={win.id}
                      label={`${displayIndex} · ${win.name}`}
                      isSelected={session.id === active?.id && index === session.active_window}
                      onClick={() => {
                        closeSurfaces();
                        send({ type: 'switch_window', session_id: session.id, index });
                        navigate(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(win.name)}`);
                      }}
                    />
                  ))}
                </SessionNavItem>
              ))}
            </div>
            {collapsed && <SideNavItem label="New session" icon={Plus} onClick={newSession} />}
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  );
}
