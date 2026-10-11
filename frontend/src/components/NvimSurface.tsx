import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { ClientConfig } from '../state/types';
import { useStore } from '../state/store';
import { STARTUP_THEME } from '../state/startupTheme';
import { getAnimations, getTerminalFontFamily, getTerminalFontSize } from '../state/configDefaults';
import { buildFontFamily, terminalTransparency } from './TerminalPane';
import { encode, MsgpackStream, type MsgpackExt } from '../lib/msgpack';
import { NvimGrid, type FloatFrame } from '../lib/nvimGrid';
import { escapeNvimText, nvimKey } from '../lib/nvimKeys';
import { cssFamily, parseGuifont, type GuiFont } from '../lib/nvimFont';
import { KeyHint } from './KeyHint';
import {
  NvimWidgets as WidgetModel,
  type KindIcons,
  type Progress,
  type SignatureHelp,
  type WidgetState,
} from '../lib/nvimWidgets';
import { NvimFloatFrames, NvimWidgets } from './NvimWidgets';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/nvim`;
const BUTTONS = ['left', 'middle', 'right'];
/** Scroll animation length when `smooth-scroll-duration` is unset. */
const SMOOTH_SCROLL_MS = 120;

/** Neovim's integer handle for a window (a msgpack ext). */
const windowId = (win: unknown): number | null => {
  const data = (win as MsgpackExt | null)?.data;
  return data ? (new MsgpackStream().push(data)[0] as number) : null;
};

/** A float's border title, as plain text. */
const TITLE_LUA = `local ok, config = pcall(vim.api.nvim_win_get_config, ...)
local title = ok and config.title or ""
if type(title) == "table" then
  title = table.concat(vim.tbl_map(function(chunk) return chunk[1] end, title))
end
return vim.trim(title)`;

let activeInput: ((keys: string) => void) | null = null;

/** Send keys (`nvim_input` notation) to the open Neovim surface. Returns false when none is open. */
export function sendToNvim(keys: string): boolean {
  if (!useStore.getState().nvimOpen || !activeInput) return false;
  activeInput(keys);
  return true;
}

/** Full-surface browser UI for the shared headless Neovim. */
export function NvimSurface({
  config,
  visible,
  activeSessionId,
  cwd,
}: {
  config: ClientConfig | null;
  visible: boolean;
  activeSessionId: string | null;
  /** The active pane's directory; Neovim changes to it when shown. */
  cwd: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef<NvimGrid | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const exitedRef = useRef(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const changeDirRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<{ kind: 'connecting' } | { kind: 'disconnected'; error: string | null } | null>({
    kind: 'connecting',
  });
  // 'guifont' and 'linespace' from Neovim override the btmux terminal font.
  const [guifont, setGuifont] = useState<GuiFont>({ families: [], size: null });
  const [linespace, setLinespace] = useState(0);
  const [pumblend, setPumblend] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [widgets, setWidgets] = useState<WidgetState | null>(null);
  const [floats, setFloats] = useState<FloatFrame[]>([]);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const modalOpen = useStore(
    (s) => !!s.overlay || s.settingsOpen || s.fileBrowserOpen || s.switcherOpen || s.windowGridOpen || s.agentGridOpen,
  );
  const selectRef = useRef<(index: number) => void>(() => {});
  const dismissPanelRef = useRef<() => void>(() => {});
  const pruneRef = useRef<() => void>(() => {});

  const family = buildFontFamily(
    guifont.families.length ? guifont.families.map(cssFamily).join(', ') : getTerminalFontFamily(config),
  );
  const size = guifont.size ?? getTerminalFontSize(config);
  const theme = config?.theme ?? STARTUP_THEME;
  const transparent = terminalTransparency(config);
  const font = { family, size, linespace, foreground: theme.foreground, background: theme.background, transparent };
  const fontRef = useRef(font);
  fontRef.current = font;
  const paletteRef = useRef(config?.color_palette);
  paletteRef.current = config?.color_palette;
  const paletteKey = JSON.stringify(config?.color_palette);
  const applyThemeRef = useRef<() => void>(() => {});
  const smoothScroll = getAnimations(config) ? (config?.terminal.smoothScrollDuration ?? SMOOTH_SCROLL_MS) : 0;
  const smoothScrollRef = useRef(smoothScroll);
  smoothScrollRef.current = smoothScroll;

  useEffect(() => {
    const container = containerRef.current!;
    const canvas = canvasRef.current!;
    const input = inputRef.current!;
    const grid = new NvimGrid(canvas, fontRef.current, layersRef.current);
    grid.smoothScroll = smoothScrollRef.current;
    gridRef.current = grid;
    const model = new WidgetModel();
    setWidgets(model.snapshot());
    grid.onEvent = (name, args) => {
      if (model.apply(name, args)) grid.cursorHidden = model.cmdlineActive;
      else if (name === 'option_set' && args[0] === 'guifont') setGuifont(parseGuifont(String(args[1])));
      else if (name === 'option_set' && args[0] === 'linespace') setLinespace(Number(args[1]) || 0);
      else if (name === 'option_set' && args[0] === 'pumblend') setPumblend(Number(args[1]) || 0);
    };
    // Keep the input on the cursor so IME candidates and composition appear there.
    const placeInput = () => {
      const rect = grid.cursorRect();
      input.style.left = `${rect.left}px`;
      input.style.top = `${rect.top}px`;
      input.style.height = `${rect.height}px`;
      input.style.font = `${fontRef.current.size}px ${fontRef.current.family}`;
    };
    // Publish widget changes once per flush, in step with the grid.
    grid.onFlush = () => {
      if (model.changed) setWidgets(model.snapshot());
      placeInput();
    };
    // Bordered floats show their title in the frame that replaces the border.
    grid.onFloats = (frames) => {
      setFloats(frames);
      for (const frame of frames) {
        const id = windowId(frame.win);
        if (!frame.border || id === null) continue;
        request('nvim_exec_lua', [TITLE_LUA, [id]], (title) =>
          setTitles((t) => (t[frame.grid] === title ? t : { ...t, [frame.grid]: String(title) })),
        );
      }
    };
    setStatus({ kind: 'connecting' });
    const stream = new MsgpackStream();
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    let attached = false;
    let disconnected = false;
    let error: string | null = null;
    let gridSize = [0, 0];

    const notify = (method: string, params: unknown[]) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode([2, method, params]));
    };
    let msgid = 0;
    const pending = new Map<number, (result: unknown) => void>();
    const request = (method: string, params: unknown[], done?: (result: unknown) => void) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      msgid += 1;
      if (done) pending.set(msgid, done);
      ws.send(encode([0, msgid, method, params]));
    };
    const sendKeys = (keys: string) => {
      if (visibleRef.current) notify('nvim_input', [keys]);
    };
    const applyTheme = () => {
      if (paletteRef.current) {
        request('nvim_exec_lua', [
          "require('btmux.theme').apply(...)",
          [paletteRef.current, !!fontRef.current.transparent],
        ]);
      }
    };
    applyThemeRef.current = applyTheme;
    changeDirRef.current = () => {
      if (cwdRef.current) request('nvim_set_current_dir', [cwdRef.current]);
    };
    selectRef.current = (index) => notify('nvim_select_popupmenu_item', [index, true, false, {}]);
    dismissPanelRef.current = () => {
      model.dismissPanel();
      setWidgets(model.snapshot());
    };
    pruneRef.current = () => {
      model.prune(Date.now());
      if (model.changed) setWidgets(model.snapshot());
    };
    grid.onDefaultColors = () =>
      request('nvim_get_hl', [0, { name: 'Normal' }], (hl) => grid.setNormal(hl as { fg?: number; bg?: number }));
    activeInput = sendKeys;

    const refit = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      grid.resizeCanvas(container.clientWidth, container.clientHeight);
      const [cols, rows] = grid.fit(container.clientWidth, container.clientHeight);
      if (attached && (cols !== gridSize[0] || rows !== gridSize[1])) {
        gridSize = [cols, rows];
        notify('nvim_ui_try_resize', [cols, rows]);
      }
    };
    refitRef.current = refit;

    ws.onopen = () => {
      grid.resizeCanvas(container.clientWidth, container.clientHeight);
      gridSize = grid.fit(container.clientWidth, container.clientHeight);
      applyTheme();
      if (visibleRef.current) changeDirRef.current();
      request('nvim_ui_attach', [
        gridSize[0],
        gridSize[1],
        {
          ext_multigrid: true,
          rgb: true,
          ext_cmdline: true,
          ext_popupmenu: true,
          ext_messages: true,
        },
      ]);
      // Kind icons from the btmux plugin (empty without mini.icons or the plugin).
      request(
        'nvim_exec_lua',
        ["local ok, kinds = pcall(require, 'btmux.kinds'); return ok and kinds.icons() or vim.empty_dict()", []],
        (icons) => {
          model.setKindIcons(icons as KindIcons);
          setWidgets(model.snapshot());
        },
      );
      // One wheel event scrolls 'mousescroll' lines; match it so content tracks the gesture.
      request('nvim_get_option_value', ['mousescroll', {}], (value) => {
        for (const [, dir, n] of String(value).matchAll(/(ver|hor):(\d+)/g)) {
          scrollLines[dir as 'ver' | 'hor'] = Math.max(1, Number(n));
        }
      });
      attached = true;
      setStatus(null);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        error = e.data;
        return;
      }
      for (const msg of stream.push(new Uint8Array(e.data as ArrayBuffer))) {
        const [type, a, b, c] = msg as unknown[];
        if (type === 2 && a === 'redraw') grid.redraw(b as unknown[]);
        else if (type === 2 && a === 'nvim_error_event') console.warn('[nvim]', b);
        else if (type === 2 && a === 'btmux_complete_info') {
          const [index, info] = b as [number, string];
          model.setInfo(index, info);
          if (model.changed) setWidgets(model.snapshot());
        } else if (type === 2 && a === 'btmux_signature') {
          model.setSignature((b as [SignatureHelp | null])[0]);
          setWidgets(model.snapshot());
        } else if (type === 2 && a === 'btmux_kind_icons') {
          model.setKindIcons((b as [KindIcons])[0]);
          setWidgets(model.snapshot());
        } else if (type === 2 && a === 'btmux_progress') {
          model.setProgress((b as [Omit<Progress, 'expires'>])[0]);
          setWidgets(model.snapshot());
        } else if (type === 1) {
          if (b) console.warn('[nvim] request failed', b);
          else pending.get(a as number)?.(c);
          pending.delete(a as number);
        } else if (type === 0) ws.send(encode([1, a, 'btmux: UI requests are not supported', null]));
      }
    };
    ws.onclose = (e) => {
      attached = false;
      // A normal close means Neovim quit (e.g. `:q`); close the surface like a TUI editor.
      if (e.code === 1000) {
        exitedRef.current = true;
        useStore.getState().setNvimOpen(false);
        return;
      }
      disconnected = true;
      setStatus({ kind: 'disconnected', error: error ?? (e.reason || null) });
    };

    const ro = new ResizeObserver(refit);
    ro.observe(container);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!attached) {
        if (disconnected && e.key === 'Enter') {
          e.preventDefault();
          setGeneration((g) => g + 1);
        }
        return;
      }
      const key = nvimKey(e);
      if (key === null) return;
      e.preventDefault();
      // Like a hit-enter prompt: the next normal-mode key dismisses output (and still reaches Neovim).
      if (model.hasPanel && !model.cmdlineActive && key !== ':') {
        model.dismissPanel();
        setWidgets(model.snapshot());
      }
      sendKeys(key);
    };
    // Dead keys and IME commit text through the textarea, which shows the composition in place.
    const flushText = () => {
      if (input.value) sendKeys(escapeNvimText(input.value));
      input.value = '';
    };
    const onCompositionStart = () => {
      input.dataset.composing = '';
    };
    const onCompositionEnd = () => {
      delete input.dataset.composing;
      flushText();
    };
    const onInput = (e: Event) => {
      if (!(e as InputEvent).isComposing) flushText();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      notify('nvim_paste', [text, true, -1]);
    };

    let pressed: { button: string; grid: number } | null = null;
    let lastCell = [-1, -1];
    let wheelX = 0;
    let wheelY = 0;
    const scrollLines = { ver: 3, hor: 6 };
    const mods = (e: MouseEvent) => (e.ctrlKey ? 'C-' : '') + (e.shiftKey ? 'S-' : '') + (e.altKey ? 'A-' : '');
    // Mouse events go to the grid under the pointer; drags stay with the grid they started on.
    const onMouseDown = (e: MouseEvent) => {
      const target = grid.gridAt(e.target);
      if (target === null) return;
      e.preventDefault();
      input.focus();
      const button = BUTTONS[e.button];
      if (!button) return;
      pressed = { button, grid: target };
      lastCell = grid.cellIn(target, e.clientX, e.clientY);
      notify('nvim_input_mouse', [button, 'press', mods(e), target, ...lastCell]);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!pressed || !visibleRef.current) return;
      const cell = grid.cellIn(pressed.grid, e.clientX, e.clientY);
      if (cell[0] === lastCell[0] && cell[1] === lastCell[1]) return;
      lastCell = cell;
      notify('nvim_input_mouse', [pressed.button, 'drag', mods(e), pressed.grid, ...cell]);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!pressed) return;
      const cell = grid.cellIn(pressed.grid, e.clientX, e.clientY);
      notify('nvim_input_mouse', [pressed.button, 'release', mods(e), pressed.grid, ...cell]);
      pressed = null;
    };
    const onWheel = (e: WheelEvent) => {
      const target = grid.gridAt(e.target);
      if (target === null) return;
      e.preventDefault();
      const dpr = window.devicePixelRatio || 1;
      const line = grid.cellHeight / dpr;
      const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? line : 1;
      wheelY += e.deltaY * scale;
      wheelX += e.deltaX * scale;
      const stepY = line * scrollLines.ver;
      const stepX = (grid.cellWidth / dpr) * scrollLines.hor;
      const cell = grid.cellIn(target, e.clientX, e.clientY);
      for (; Math.abs(wheelY) >= stepY; wheelY -= Math.sign(wheelY) * stepY) {
        notify('nvim_input_mouse', ['wheel', wheelY > 0 ? 'down' : 'up', mods(e), target, ...cell]);
      }
      for (; Math.abs(wheelX) >= stepX; wheelX -= Math.sign(wheelX) * stepX) {
        notify('nvim_input_mouse', ['wheel', wheelX > 0 ? 'right' : 'left', mods(e), target, ...cell]);
      }
    };
    const onContextMenu = (e: Event) => {
      if (grid.gridAt(e.target) !== null) e.preventDefault();
    };

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);
    input.addEventListener('paste', onPaste);
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    if (visibleRef.current) input.focus();

    return () => {
      applyThemeRef.current = () => {};
      if (activeInput === sendKeys) activeInput = null;
      ro.disconnect();
      layersRef.current?.replaceChildren();
      setFloats([]);
      setTitles({});
      ws.onclose = null;
      ws.close();
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('input', onInput);
      input.removeEventListener('compositionstart', onCompositionStart);
      input.removeEventListener('compositionend', onCompositionEnd);
      input.removeEventListener('paste', onPaste);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [generation]);

  useEffect(() => {
    if (visible && exitedRef.current) {
      exitedRef.current = false;
      setGeneration((g) => g + 1);
    }
    if (visible) changeDirRef.current();
  }, [visible]);

  useEffect(() => {
    applyThemeRef.current();
  }, [paletteKey, transparent]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.smoothScroll = smoothScroll;
  }, [smoothScroll]);

  // Take focus back when a modal closes; closing a dialog restores focus to
  // whatever was focused before it opened, often a terminal pane.
  useEffect(() => {
    if (!visible || modalOpen) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [visible, modalOpen, generation, activeSessionId]);

  // Re-measure once the configured font is loaded or changes.
  useEffect(() => {
    let cancelled = false;
    void document.fonts
      .load(`${size}px ${family}`)
      .catch(() => {})
      .then(() => {
        if (cancelled) return;
        gridRef.current?.setFont(fontRef.current);
        refitRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [family, size, linespace, theme.foreground, theme.background, transparent, generation]);

  return (
    <div
      ref={containerRef}
      inert={!visible}
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        overflow: 'hidden',
        visibility: visible ? undefined : 'hidden',
        background: transparent ? 'transparent' : theme.background,
      }}
      onMouseDown={() => inputRef.current?.focus()}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {/* Window and float canvases; no z-index, so they stack with the frames and widgets. */}
      <div ref={layersRef} className="pointer-events-none absolute inset-0" />
      {gridRef.current && <NvimFloatFrames floats={floats} titles={titles} grid={gridRef.current} />}
      {widgets && gridRef.current && (
        <NvimWidgets
          state={widgets}
          grid={gridRef.current}
          onSelect={(i) => selectRef.current(i)}
          onDismissPanel={() => dismissPanelRef.current()}
          onExpire={() => pruneRef.current()}
          pumblend={pumblend}
        />
      )}
      <textarea
        ref={inputRef}
        aria-label="Neovim input"
        data-nvim-input
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        // Invisible until an IME composition, which it then shows at the cursor.
        className="absolute top-0 left-0 h-px min-w-px resize-none overflow-hidden border-0 bg-body p-0 text-primary underline opacity-0 outline-none field-sizing-content data-composing:z-50 data-composing:opacity-100"
      />
      {status && (
        <Center className="absolute inset-0 z-50 bg-body/90">
          {status.kind === 'connecting' ? (
            <Spinner label="Starting Neovim…" />
          ) : (
            <Card padding={4} elevation="high">
              <VStack gap={3} hAlign="start">
                <VStack gap={1}>
                  <Text weight="semibold">Neovim disconnected</Text>
                  {status.error && <Text color="secondary">{status.error}</Text>}
                </VStack>
                <HStack gap={2} vAlign="center">
                  <Button label="Restart" variant="primary" onClick={() => setGeneration((g) => g + 1)} />
                  <KeyHint keys={['enter']} label="restart" />
                </HStack>
              </VStack>
            </Card>
          )}
        </Center>
      )}
    </div>
  );
}
