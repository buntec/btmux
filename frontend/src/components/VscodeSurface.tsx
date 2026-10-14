import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Code } from '@astryxdesign/core/Code';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Link } from '@astryxdesign/core/Link';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import type { VscodeStatus } from '../generated/protocol';
import { ClientConfig, LayoutRect } from '../state/types';
import { useStore } from '../state/store';
import { STARTUP_THEME } from '../state/startupTheme';
import { DOUBLE_ESC_MS } from './NvimSurface';

/**
 * This page's `@font-face` rules with absolute URLs, so the same-origin iframe
 * can use btmux's bundled terminal fonts (the extension sets VS Code's font).
 */
function fontFaceCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      continue; // Cross-origin stylesheet.
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of Array.from(cssRules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      rules.push(
        rule.cssText.replace(
          /url\((['"]?)([^'")]+)\1\)/g,
          (_, quote: string, url: string) => `url(${quote}${new URL(url, base).href}${quote})`,
        ),
      );
    }
  }
  return rules.join('\n');
}

/** VS Code (`/vscode/`, proxied by the backend), pinned over a pane like the Neovim surface. */
export function VscodeSurface({
  config,
  open,
  paneId,
  rect,
  focused,
  zoomed,
  onActivate,
  cwd,
}: {
  config: ClientConfig | null;
  open: boolean;
  paneId: string | null;
  /** The pinned pane's rect, or null while it isn't shown. */
  rect: LayoutRect | null;
  focused: boolean;
  zoomed: boolean;
  onActivate: () => void;
  /** The pane's folder, opened when the surface is opened or moved. */
  cwd: string | null;
}) {
  const visible = open && rect !== null;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  // Changing the iframe's src (or moving it in the DOM) reloads VS Code, so
  // only switch folders when opened over a pane in another one.
  const [folder, setFolder] = useState(cwd);
  useEffect(() => {
    if (open && cwd && cwd !== folder) {
      setLoaded(false);
      setFolder(cwd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paneId]);
  const src = `/vscode/${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const modalOpen = useStore(
    (s) => !!s.overlay || s.settingsOpen || s.fileBrowserOpen || s.switcherOpen || s.windowGridOpen || s.agentGridOpen,
  );
  const theme = config?.theme ?? STARTUP_THEME;

  // Ask the backend to start VS Code before loading it; it may need the user
  // to accept the VS Code Server license first, or not be installed.
  const [status, setStatus] = useState<VscodeStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = status?.state === 'ready';
  useEffect(() => {
    if (!open || ready) return;
    let cancelled = false;
    setStatus(null);
    fetch('/api/vscode')
      .then((r) => r.json() as Promise<VscodeStatus>)
      .catch((e: unknown) => ({ state: 'error', message: String(e) }) as const)
      .then((s) => !cancelled && setStatus(s));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt]);
  const acceptLicense = () => {
    setStatus(null);
    fetch('/api/vscode/license', { method: 'POST' })
      .then((r) => r.json() as Promise<VscodeStatus>)
      .catch((e: unknown) => ({ state: 'error', message: String(e) }) as const)
      .then(setStatus);
  };
  const close = () => useStore.getState().setVscodeOpen(false);

  // Key events inside the iframe never reach this document. It is same-origin,
  // so replay each keydown to the global keybinding hook first, and swallow it
  // if a btmux binding handled it. As in Neovim, a quick second Esc hides the
  // surface; the first one still reaches VS Code.
  const attach = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    setLoaded(true);
    const fonts = win.document.createElement('style');
    fonts.textContent = fontFaceCss();
    win.document.head.append(fonts);
    let lastEsc = -Infinity;
    const onKeyDown = (e: KeyboardEvent) => {
      const replay = new KeyboardEvent('keydown', {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(replay);
      if (replay.defaultPrevented) {
        lastEsc = -Infinity;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key !== 'Escape' || e.repeat || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) {
        lastEsc = -Infinity;
      } else if (e.timeStamp - lastEsc < DOUBLE_ESC_MS) {
        lastEsc = -Infinity;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else lastEsc = e.timeStamp;
    };
    const onMouseDown = () => {
      if (!focusedRef.current) onActivateRef.current();
    };
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('mousedown', onMouseDown, true);
  };

  // Take focus when its pane is active, and back after a modal closes.
  useEffect(() => {
    if (!focused || modalOpen || !visible) return;
    const id = window.setTimeout(() => iframeRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [focused, modalOpen, visible, loaded]);

  return (
    <div
      inert={!visible}
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        ...(rect
          ? { top: `${rect.top}%`, left: `${rect.left}%`, width: `${rect.width}%`, height: `${rect.height}%` }
          : { inset: 0 }),
        // Mirrors TerminalPane's border.
        border: `1px solid ${zoomed ? theme.magenta : focused ? theme.blue : theme.selectionBackground}`,
        zIndex: 30,
        overflow: 'hidden',
        visibility: visible ? undefined : 'hidden',
        background: theme.background,
      }}
    >
      {ready && (
        <iframe
          ref={iframeRef}
          src={src}
          title="VS Code"
          onLoad={attach}
          allow="clipboard-read; clipboard-write"
          style={{ display: 'block', width: '100%', height: '100%', border: 0 }}
        />
      )}
      {!loaded && (
        <Center className="absolute inset-0 bg-body/90">
          {status?.state === 'license' ? (
            <Card padding={4} elevation="high" maxWidth={480}>
              <VStack gap={3} hAlign="start">
                <VStack gap={1}>
                  <Text weight="semibold">Visual Studio Code Server license</Text>
                  <Text color="secondary">
                    btmux runs VS Code with <Code>code serve-web</Code>. By using it, you agree to the{' '}
                    <Link href="https://aka.ms/vscode-server-license" isExternalLink>
                      Visual Studio Code Server License Terms
                    </Link>{' '}
                    and the{' '}
                    <Link href="https://privacy.microsoft.com/en-US/privacystatement" isExternalLink>
                      Microsoft Privacy Statement
                    </Link>
                    .
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center">
                  <Button label="Accept" variant="primary" onClick={acceptLicense} />
                  <Button label="Cancel" onClick={close} />
                </HStack>
              </VStack>
            </Card>
          ) : status?.state === 'error' ? (
            <Card padding={4} elevation="high" maxWidth={560}>
              <VStack gap={3} hAlign="start">
                <VStack gap={1}>
                  <Text weight="semibold">VS Code didn't start</Text>
                  <Text color="secondary" className="whitespace-pre-wrap">
                    {status.message}
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center">
                  <Button label="Retry" variant="primary" onClick={() => setAttempt((a) => a + 1)} />
                  <Button label="Close" onClick={close} />
                </HStack>
              </VStack>
            </Card>
          ) : (
            <Spinner label="Starting VS Code…" />
          )}
        </Center>
      )}
    </div>
  );
}
