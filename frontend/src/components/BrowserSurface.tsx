import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { BrowserClientMessage, BrowserServerMessage } from '../generated/protocol';
import { addressToUrl, buttonName, containRect, keyMessage, modifierBits } from '../lib/browserInput';
import { RESERVED_CMD_KEYS } from '../lib/nvimKeys';
import { ClientConfig, LayoutRect } from '../state/types';
import { useStore } from '../state/store';
import { STARTUP_THEME } from '../state/startupTheme';
import { DOUBLE_ESC_MS } from './NvimSurface';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser`;
const FRAME_HEADER = 4;
const RESIZE_DEBOUNCE_MS = 80;
const BLANK = 'about:blank';

type PageInfo = Extract<BrowserServerMessage, { type: 'page' }>;

/** A shared Chromium on the server (`/ws/browser`), pinned over a pane like the Neovim surface. */
export function BrowserSurface({
  config,
  open,
  rect,
  focused,
  zoomed,
  onActivate,
}: {
  config: ClientConfig | null;
  open: boolean;
  /** The pinned pane's rect, or null while it isn't shown. */
  rect: LayoutRect | null;
  focused: boolean;
  zoomed: boolean;
  onActivate: () => void;
}) {
  const visible = open && rect !== null;
  const theme = config?.theme ?? STARTUP_THEME;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The page's size in CSS px, from the latest frame. */
  const pageSize = useRef({ width: 0, height: 0 });
  const heldKeys = useRef(new Map<string, ReactKeyboardEvent<HTMLTextAreaElement>['nativeEvent']>());
  const lastEsc = useRef(-Infinity);
  const [page, setPage] = useState<PageInfo>({ type: 'page', url: BLANK, title: '', loading: false });
  const [address, setAddress] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const modalOpen = useStore(
    (s) => !!s.overlay || s.settingsOpen || s.fileBrowserOpen || s.switcherOpen || s.windowGridOpen || s.agentGridOpen,
  );

  /** Typed while the socket connects, which starts Chromium. */
  const pendingUrl = useRef<string | null>(null);
  const send = (message: BrowserClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else if (message.type === 'navigate') pendingUrl.current = message.url;
  };
  const close = () => useStore.getState().setBrowserOpen(false);

  const reportSize = () => {
    const box = canvasRef.current?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) {
      send({ type: 'resize', width: Math.round(box.width), height: Math.round(box.height) });
    }
  };

  // Connected only while shown, so a hidden surface costs no frames.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    const socket = new WebSocket(`${WS_URL}?dpr=${window.devicePixelRatio}`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    let disposed = false;
    let failed = false;
    let raf = 0;
    let next: { bitmap: ImageBitmap; width: number; height: number } | null = null;
    const draw = () => {
      raf = 0;
      const frame = next;
      next = null;
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!frame || !canvas || !context) return;
      if (canvas.width !== frame.bitmap.width) canvas.width = frame.bitmap.width;
      if (canvas.height !== frame.bitmap.height) canvas.height = frame.bitmap.height;
      context.drawImage(frame.bitmap, 0, 0);
      frame.bitmap.close();
      pageSize.current = { width: frame.width, height: frame.height };
      setPainted(true);
      // The server skips to the latest frame, so a slow link or hidden tab can't fall behind.
      send({ type: 'ack' });
    };
    socket.onopen = () => {
      reportSize();
      if (pendingUrl.current) send({ type: 'navigate', url: pendingUrl.current });
      pendingUrl.current = null;
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as BrowserServerMessage;
        if (message.type === 'page') setPage(message);
        else {
          failed = true;
          setError(message.message);
        }
        return;
      }
      const data = event.data as ArrayBuffer;
      const header = new DataView(data);
      const width = header.getUint16(0);
      const height = header.getUint16(2);
      createImageBitmap(new Blob([new Uint8Array(data, FRAME_HEADER)], { type: 'image/jpeg' })).then(
        (bitmap) => {
          if (disposed) {
            bitmap.close();
            return;
          }
          next?.bitmap.close();
          next = { bitmap, width, height };
          raf ||= requestAnimationFrame(draw);
        },
        () => send({ type: 'ack' }),
      );
    };
    socket.onclose = (event) => {
      if (!disposed && !failed) setError(event.reason || 'The connection to the browser closed.');
    };
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      next?.bitmap.close();
      next = null;
      socket.close();
      socketRef.current = null;
      heldKeys.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, generation]);

  // The page takes the size of the space below the toolbar.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reportSize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(canvas);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Take focus when its pane is active, and back after a modal closes.
  useEffect(() => {
    if (!focused || modalOpen || !visible) return;
    const id = window.setTimeout(() => {
      if (document.activeElement === addressRef.current) return;
      if (page.url === BLANK) addressRef.current?.focus();
      else inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, modalOpen, visible]);

  const pagePoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    const { width, height } = pageSize.current;
    const shown = containRect(box.width, box.height, width, height);
    return {
      x: ((e.clientX - box.left - shown.left) * (width || box.width)) / shown.width,
      y: ((e.clientY - box.top - shown.top) * (height || box.height)) / shown.height,
    };
  };

  const sendWheel = (e: { clientX: number; clientY: number }, modifiers: number, deltaX: number, deltaY: number) =>
    send({
      type: 'mouse',
      kind: 'mouseWheel',
      ...pagePoint(e),
      button: 'none',
      buttons: 0,
      click_count: 0,
      modifiers,
      delta_x: deltaX,
      delta_y: deltaY,
    });

  // React's wheel listener is passive, and the outer page mustn't scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 : 1;
      sendWheel(e, modifierBits(e), e.deltaX * unit, e.deltaY * unit);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMouse = (kind: string, e: React.MouseEvent<HTMLCanvasElement>) =>
    send({
      type: 'mouse',
      kind,
      ...pagePoint(e),
      button: kind === 'mouseMoved' ? 'none' : buttonName(e.button),
      buttons: e.buttons,
      click_count: kind === 'mouseMoved' ? 0 : Math.max(e.detail, 1),
      modifiers: modifierBits(e),
      delta_x: 0,
      delta_y: 0,
    });

  // One move per frame.
  const moveRaf = useRef(0);
  const lastMove = useRef<React.MouseEvent<HTMLCanvasElement> | null>(null);
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    lastMove.current = e;
    moveRaf.current ||= requestAnimationFrame(() => {
      moveRaf.current = 0;
      if (lastMove.current) sendMouse('mouseMoved', lastMove.current);
    });
  };

  // A finger drag scrolls; a tap arrives as mouse events.
  const touchAt = useRef<{ x: number; y: number } | null>(null);
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'touch' || !touchAt.current) return;
    sendWheel(e, 0, touchAt.current.x - e.clientX, touchAt.current.y - e.clientY);
    touchAt.current = { x: e.clientX, y: e.clientY };
  };

  const focusAddress = () => {
    addressRef.current?.focus();
    addressRef.current?.select();
  };
  const focusPage = () => inputRef.current?.focus();
  const navigate = () => {
    if (address?.trim()) send({ type: 'navigate', url: addressToUrl(address) });
    setAddress(null);
    focusPage();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    // Composed text and phone keyboards arrive through `input`.
    if (native.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'l') {
      e.preventDefault();
      focusAddress();
      return;
    }
    if (e.metaKey && key === 'r') {
      e.preventDefault();
      send({ type: 'reload' });
      return;
    }
    // Cmd chords the browser or desktop app keeps, including paste.
    if (e.metaKey && (RESERVED_CMD_KEYS.has(key) || /^Digit\d$/.test(e.code))) return;
    e.preventDefault();
    // A quick second Esc hides the surface; the first one still reaches the page.
    if (e.key === 'Escape' && !e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (native.timeStamp - lastEsc.current < DOUBLE_ESC_MS) {
        lastEsc.current = -Infinity;
        close();
        return;
      }
      lastEsc.current = native.timeStamp;
    } else lastEsc.current = -Infinity;
    heldKeys.current.set(e.code, native);
    send(keyMessage(native, true));
  };
  // A key whose keydown a keybinding took has no keyup here either.
  const onKeyUp = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (heldKeys.current.delete(e.code)) send(keyMessage(e.nativeEvent, false));
  };
  const releaseKeys = () => {
    for (const held of heldKeys.current.values()) send(keyMessage(held, false));
    heldKeys.current.clear();
  };

  const flushText = () => {
    const input = inputRef.current;
    if (input?.value) send({ type: 'insert_text', text: input.value });
    if (input) input.value = '';
  };

  const shownAddress = address ?? (page.url === BLANK ? '' : page.url);

  return (
    <VStack
      inert={!visible}
      aria-hidden={!visible}
      gap={0}
      className="absolute overflow-hidden"
      style={{
        ...(rect
          ? { top: `${rect.top}%`, left: `${rect.left}%`, width: `${rect.width}%`, height: `${rect.height}%` }
          : { inset: 0 }),
        // Mirrors TerminalPane's border.
        border: `1px solid ${zoomed ? theme.magenta : focused ? theme.blue : theme.selectionBackground}`,
        zIndex: 30,
        visibility: visible ? undefined : 'hidden',
        background: theme.background,
      }}
    >
      <HStack gap={1} vAlign="center" className="btm-mono shrink-0 bg-body p-1">
        <IconButton
          label="Back"
          tooltip="Back"
          size="sm"
          variant="ghost"
          icon={<ArrowLeft />}
          onClick={() => send({ type: 'back' })}
        />
        <IconButton
          label="Forward"
          tooltip="Forward"
          size="sm"
          variant="ghost"
          icon={<ArrowRight />}
          onClick={() => send({ type: 'forward' })}
        />
        <IconButton
          label="Reload"
          tooltip="Reload"
          size="sm"
          variant="ghost"
          isLoading={page.loading}
          icon={<RotateCw />}
          onClick={() => send({ type: 'reload' })}
        />
        <div className="min-w-0 flex-1">
          <TextInput
            ref={addressRef}
            label="Address"
            isLabelHidden
            size="sm"
            placeholder="Search or enter address"
            value={shownAddress}
            onChange={(value) => setAddress(value)}
            onEnter={navigate}
            onFocus={focusAddress}
            onBlur={() => setAddress(null)}
            onKeyDown={(e) => {
              // Focus moves to the page's input, which mustn't get the newline.
              if (e.key === 'Enter') e.preventDefault();
              if (e.key === 'Escape') {
                e.preventDefault();
                setAddress(null);
                focusPage();
              }
            }}
          />
        </div>
        <IconButton
          label="Hide browser"
          tooltip="Hide browser"
          size="sm"
          variant="ghost"
          icon={<X />}
          onClick={close}
        />
      </HStack>
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          aria-label={page.title || 'Browser page'}
          data-browser-canvas
          className="absolute inset-0 block size-full touch-none object-contain"
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') touchAt.current = { x: e.clientX, y: e.clientY };
            else e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            touchAt.current = null;
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            focusPage();
            if (!focused) onActivate();
            sendMouse('mousePressed', e);
          }}
          onMouseMove={onMouseMove}
          onMouseUp={(e) => sendMouse('mouseReleased', e)}
          onContextMenu={(e) => e.preventDefault()}
        />
        <textarea
          ref={inputRef}
          aria-label="Browser input"
          data-browser-input
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          // Invisible until an IME composition, which it then shows.
          className="absolute top-0 left-0 h-px min-w-px resize-none overflow-hidden border-0 bg-body p-0 text-primary underline opacity-0 outline-none field-sizing-content data-composing:z-50 data-composing:opacity-100"
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={releaseKeys}
          onCompositionStart={(e) => {
            e.currentTarget.dataset.composing = '';
          }}
          onCompositionEnd={(e) => {
            delete e.currentTarget.dataset.composing;
            flushText();
          }}
          onInput={(e) => {
            if (!(e.nativeEvent as InputEvent).isComposing) flushText();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (text) send({ type: 'insert_text', text });
          }}
        />
        {error ? (
          <Center className="absolute inset-0 bg-body/90">
            <Card padding={4} elevation="high" maxWidth={560}>
              <VStack gap={3} hAlign="start">
                <VStack gap={1}>
                  <Text weight="semibold">The browser isn't running</Text>
                  <Text color="secondary" className="whitespace-pre-wrap">
                    {error}
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center">
                  <Button label="Restart" variant="primary" onClick={() => setGeneration((g) => g + 1)} />
                  <Button label="Close" onClick={close} />
                </HStack>
              </VStack>
            </Card>
          </Center>
        ) : (
          !painted && (
            <Center className="pointer-events-none absolute inset-0 bg-body/90">
              <Spinner label="Starting the browser…" />
            </Center>
          )
        )}
      </div>
    </VStack>
  );
}
