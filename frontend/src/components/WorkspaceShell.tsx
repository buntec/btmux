import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@astryxdesign/core/AppShell';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Badge } from '@astryxdesign/core/Badge';
import { Command, Plus, Search, Settings2, Keyboard, Info, Grid2X2 } from 'lucide-react';
import type { IconType } from '@astryxdesign/core/Icon';
import { useStore } from '../state/store';
import { sortSessions, SESSION_MRU_EVENT } from '../state/sessionMru';
import { sortWindows, WINDOW_MRU_EVENT } from '../state/windowMru';
import { getAnimations, getSessionSort, getWindowSort } from '../state/configDefaults';
import { AnimatedAppIcon } from './AnimatedAppIcon';
import { useTerminalPalette } from './BtmuxTheme';
import type { ClientMessage } from '../protocol/messages';

let mruVersion = 0;
for (const event of [SESSION_MRU_EVENT, WINDOW_MRU_EVENT]) window.addEventListener(event, () => mruVersion++);

// Monogram icon so sessions stay distinguishable in the collapsed rail.
const sessionIcons = new Map<string, IconType>();
function sessionIcon(name: string): IconType {
  let icon = sessionIcons.get(name);
  if (!icon) {
    const glyph = Array.from(name).slice(0, 2).join('') || '?';
    icon = (props) => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <text
          x="12"
          y="12.5"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={glyph.length > 1 ? 10 : 13}
          fontWeight={700}
          fill="currentColor"
          stroke="none"
        >
          {glyph}
        </text>
      </svg>
    );
    sessionIcons.set(name, icon);
  }
  return icon;
}

export function WorkspaceShell({ children, send }: { children: ReactNode; send: (message: ClientMessage) => void }) {
  const sessions = useStore((state) => state.allSessions);
  const config = useStore((state) => state.config);
  const palette = useTerminalPalette();
  const setOverlay = useStore((state) => state.setOverlay);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const setSwitcherOpen = useStore((state) => state.setSwitcherOpen);
  const setWindowGridOpen = useStore((state) => state.setWindowGridOpen);
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
  return (
    <AppShell
      height="fill"
      contentPadding={0}
      variant="section"
      sideNav={
        <SideNav
          aria-label="Sessions and windows"
          collapsible={{
            isCollapsed: collapsed,
            onCollapsedChange: (value) => {
              setCollapsed(value);
              try {
                localStorage.setItem('btmux-nav-collapsed', String(value));
              } catch {}
            },
          }}
          header={
            <SideNavHeading
              heading="btmux"
              icon={
                <AnimatedAppIcon
                  animated={getAnimations(config)}
                  palette={palette}
                  className={collapsed ? '-my-2 size-12 shrink-0' : '-my-2 -ml-4 size-12 shrink-0'}
                />
              }
            />
          }
          footerIcons={
            <>
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
            endContent={
              <IconButton
                label="New session"
                tooltip="New session"
                variant="ghost"
                size="sm"
                icon={<Plus />}
                onClick={() => {
                  closeSurfaces();
                  setOverlay({ mode: 'prompt', title: 'New session', value: '', action: 'new-session' });
                }}
              />
            }
          >
            {sortSessions(sessions, getSessionSort(config)).map((session) => (
              <SideNavItem
                key={session.id}
                label={session.name}
                icon={sessionIcon(session.name)}
                collapsible
                isSelected={session.id === active?.id}
                endContent={<Badge variant="neutral" label={session.windows.length} />}
                onClick={() => {
                  closeSurfaces();
                  navigate(`/s/${encodeURIComponent(session.name)}`);
                }}
              >
                {sortWindows(session.windows, getWindowSort(config)).map(({ win, index }) => (
                  <SideNavItem
                    key={win.id}
                    label={`${index} · ${win.name}`}
                    isSelected={session.id === active?.id && index === session.active_window}
                    onClick={() => {
                      closeSurfaces();
                      send({ type: 'switch_window', session_id: session.id, index });
                      navigate(`/s/${encodeURIComponent(session.name)}/w/${encodeURIComponent(win.name)}`);
                    }}
                  />
                ))}
              </SideNavItem>
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  );
}
