import { WTerm, type CellData, type SearchState } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import '@wterm/dom/css';
import type { Theme } from '../state/types';
import { findUrls } from './urlDetect';

export interface PaneTerminalOptions {
  theme: Theme;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  cursorBlink: boolean;
  /** Retained lines; converted to libghostty's byte budget. */
  scrollback: number;
  disableStdin?: boolean;
}

export interface TerminalRow {
  text: string;
  /** String index → cell column. */
  cols: number[];
  /** This row continues the previous one (soft wrap). */
  wrapped: boolean;
}

// libghostty's scrollback limit is a byte budget; assume ~1 KB per line.
const SCROLLBACK_BYTES_PER_LINE = 1000;
const encoder = new TextEncoder();

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

const rgb = (hex: string | undefined, fallback: number) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '');
  return m ? parseInt(m[1], 16) : fallback;
};

/** Ancestor transform scale; getBoundingClientRect includes it (mirror thumbnails). */
const elementScale = (element: HTMLElement) => {
  const scale = element.offsetWidth ? element.getBoundingClientRect().width / element.offsetWidth : 1;
  return scale > 0 && Math.abs(scale - 1) > 0.01 ? scale : 1;
};

interface WTermMeasurement {
  _measureCharSize(): { charWidth: number; rowHeight: number } | null;
  _setRowHeight(): void;
  _charWidth: number;
  _rowHeight: number;
}

/** Make wterm's private cell measurement ignore ancestor transforms. */
function unscaleMeasurement(wterm: WTerm, element: HTMLElement) {
  const internals = wterm as unknown as WTermMeasurement;
  const measureCharSize = internals._measureCharSize.bind(wterm);
  internals._measureCharSize = () => {
    const measured = measureCharSize();
    const scale = elementScale(element);
    if (!measured || scale === 1) return measured;
    const charWidth = measured.charWidth / scale;
    const rowHeight = measured.rowHeight / scale;
    internals._charWidth = charWidth;
    internals._rowHeight = rowHeight;
    element.style.setProperty('--term-cell-width', `${charWidth}px`);
    return { charWidth, rowHeight };
  };
  const setRowHeight = internals._setRowHeight.bind(wterm);
  internals._setRowHeight = () => {
    setRowHeight();
    const scale = elementScale(element);
    if (scale === 1) return;
    internals._rowHeight /= scale;
    element.style.setProperty('--term-row-height', `${internals._rowHeight}px`);
  };
}

interface WTermInput {
  syncInputPosition(): void;
  positionTextarea(): void;
}

/**
 * Move wterm's textarea to the cursor after every render, not only while
 * composing. It keeps the offset from its last focus, so after `clear` it
 * holds the scroll height and wterm scrolls the rows out of view.
 */
function trackInputPosition(wterm: WTerm) {
  const input = (wterm as unknown as { input: WTermInput | null }).input;
  if (input) input.syncInputPosition = () => input.positionTextarea();
}

/** Row height from the font's ascent and descent, as ghostty-web measured it. */
const fontRowHeight = (family: string, size: number, weight: number) => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return Math.round(size * 1.2);
  ctx.font = `${weight} ${size}px ${family}`;
  const m = ctx.measureText('M');
  return Math.ceil((m.fontBoundingBoxAscent ?? size * 0.8) + (m.fontBoundingBoxDescent ?? size * 0.2));
};

// Soft-wrapped rows joined to find a URL under the pointer.
const MAX_URL_ROWS = 32;

/** wterm's OSC 8 link modifier: Command on macOS, Control elsewhere. */
const linkModifier = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  navigator.platform.startsWith('Mac') ? event.metaKey : event.ctrlKey;

const cellText = (cell: CellData) => cell.chars ?? (cell.char > 32 ? String.fromCodePoint(cell.char) : ' ');

/** btmux's view of a wterm emulator with the libghostty core. */
export class PaneTerminal {
  private readonly wterm: WTerm;
  private readonly core: GhosttyCore;
  readonly element: HTMLElement;
  private dataListeners = new Set<(data: Uint8Array) => void>();
  private resizeListeners = new Set<(cols: number, rows: number) => void>();
  private inputDisabled: boolean;
  private scrollAccumPx = 0;
  private forwardingWheel = false;
  private swallowMouseUp = false;
  private pointer: { x: number; y: number; target: EventTarget | null } | null = null;
  private linkModifierHeld = false;
  private hoveredLink: string | null = null;

  private constructor(wterm: WTerm, element: HTMLElement, core: GhosttyCore, inputDisabled: boolean) {
    this.wterm = wterm;
    this.core = core;
    this.element = element;
    this.inputDisabled = inputDisabled;
    // Never null: wterm echoes input locally without a handler.
    wterm.onData = (data) => this.emit(data);
    wterm.onBinary = (data) => this.emit(data);
    wterm.onResize = (cols, rows) => this.resizeListeners.forEach((fn) => fn(cols, rows));
    element.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    element.addEventListener('mousedown', this.onMouseDown, true);
    element.addEventListener('mouseup', this.onMouseUp, true);
    element.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('mouseleave', this.onMouseLeave);
    element.addEventListener('scroll', this.onLinkModifier, { passive: true });
    document.addEventListener('keydown', this.onLinkModifier, true);
    document.addEventListener('keyup', this.onLinkModifier, true);
  }

  static async open(host: HTMLElement, options: PaneTerminalOptions, size?: { cols: number; rows: number }) {
    const primaryFamily = options.fontFamily
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    await Promise.allSettled([
      document.fonts.load(`${options.fontWeight} ${options.fontSize}px "${primaryFamily}"`),
      document.fonts.load(`${Math.min(options.fontWeight + 200, 900)} ${options.fontSize}px "${primaryFamily}"`),
    ]);
    const core = await GhosttyCore.load({ scrollbackLimit: options.scrollback * SCROLLBACK_BYTES_PER_LINE });
    const element = document.createElement('div');
    element.className = 'btm-wterm';
    element.style.setProperty('--term-font-family', options.fontFamily);
    element.style.setProperty('--term-font-size', `${options.fontSize}px`);
    element.style.fontWeight = String(options.fontWeight);
    // The host sets wterm's row height (default 17px); init() measures it.
    element.style.setProperty(
      '--term-row-height',
      `${fontRowHeight(options.fontFamily, options.fontSize, options.fontWeight)}px`,
    );
    host.appendChild(element);
    const wterm = new WTerm(element, {
      core,
      cols: size?.cols,
      rows: size?.rows,
      autoResize: false,
      cursorBlink: options.cursorBlink,
    });
    unscaleMeasurement(wterm, element);
    const term = new PaneTerminal(wterm, element, core, !!options.disableStdin);
    term.setTheme(options.theme);
    // With a supplied core, init() runs synchronously and focuses its input.
    // Give focus back before awaiting, as other panes may open meanwhile; panes
    // focus themselves once their replay is shown.
    const focused = document.activeElement;
    const initialized = wterm.init();
    if (focused instanceof HTMLElement && focused !== document.body) focused.focus();
    else term.blur();
    try {
      await initialized;
    } catch (e) {
      element.remove();
      throw e;
    }
    trackInputPosition(wterm);
    // init() locks the element's height; btmux sizes it.
    element.style.height = '';
    // Stay focusable while the pane hides its replay.
    const input = element.querySelector('textarea');
    if (input) input.style.visibility = 'visible';
    return term;
  }

  get cols() {
    return this.wterm.cols;
  }

  get rows() {
    return this.wterm.rows;
  }

  write(data: Uint8Array | string) {
    this.wterm.write(data);
  }

  /** Inactive panes hide the cursor: over a transparent background it would leave a visible outline. */
  setCursorHidden(hidden: boolean) {
    this.element.classList.toggle('btm-wterm-cursor-hidden', hidden);
  }

  /** Notify `observer` when wterm's cell measurement may have changed (fonts, hinting). */
  observeCellSize(observer: ResizeObserver) {
    const probe = this.element.querySelector('.term-size-probe');
    if (probe) observer.observe(probe);
  }

  /** Throttle application scrolling; let wterm encode mouse reports. */
  private onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || this.forwardingWheel) return;
    const tracking = this.mouseTracking() !== 0;
    // Scrollback scrolls natively.
    if (!tracking && !this.usingAltScreen()) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (tracking && (event.shiftKey || !this.isScrolledToBottom())) return;
    const lineHeight = this.measureCell()?.height ?? 16;
    const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? this.element.clientHeight : 1;
    event.preventDefault();
    event.stopPropagation();
    this.scrollAccumPx += event.deltaY * unit;
    const ticks = Math.trunc(this.scrollAccumPx / lineHeight);
    this.scrollAccumPx -= ticks * lineHeight;
    if (!tracking) {
      this.emit((ticks > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(ticks)));
      return;
    }
    this.forwardingWheel = true;
    try {
      for (let i = 0; i < Math.abs(ticks); i++) {
        this.element.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: Math.sign(ticks),
            clientX: event.clientX,
            clientY: event.clientY,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
          }),
        );
      }
    } finally {
      this.forwardingWheel = false;
    }
  };

  /** Plain-text URL at a viewport point; wterm handles OSC 8 links itself. */
  private urlAt(clientX: number, clientY: number, target: EventTarget | null) {
    if (target instanceof Element && target.closest('.term-link')) return null;
    const cell = this.measureCell();
    if (!cell) return null;
    const rect = this.element.getBoundingClientRect();
    const scale = elementScale(this.element);
    const row = Math.floor(((clientY - rect.top) / scale + this.element.scrollTop) / cell.height);
    const col = Math.floor((clientX - rect.left) / scale / cell.width);
    if (row < 0 || row >= this.rowCount || col < 0 || col >= this.cols) return null;
    let first = row;
    while (first > 0 && row - first < MAX_URL_ROWS && this.readRow(first).wrapped) first--;
    let text = '';
    const cells: { line: number; column: number }[] = [];
    for (let y = first; y < this.rowCount && y - first < 2 * MAX_URL_ROWS; y++) {
      const r = this.readRow(y);
      if (y > first && !r.wrapped) break;
      text += r.text;
      for (const column of r.cols) cells.push({ line: y, column });
    }
    // Last string index at or before the pointer; one column back covers wide cells.
    let index = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].line === row && cells[i].column <= col && cells[i].column >= col - 1) index = i;
    }
    const match = findUrls(text).find((m) => m.start <= index && index < m.end);
    if (!match) return null;
    const spans: { line: number; column: number; length: number }[] = [];
    for (let i = match.start; i < match.end; i++) {
      const { line, column } = cells[i];
      const last = spans[spans.length - 1];
      if (last?.line === line) last.length = column - last.column + 1;
      else spans.push({ line, column, length: 1 });
    }
    return { url: match.url, spans };
  }

  /** Underline the URL under the pointer while the link modifier is held. */
  private updateUrlHover() {
    const { pointer } = this;
    const match = this.linkModifierHeld && pointer ? this.urlAt(pointer.x, pointer.y, pointer.target) : null;
    const key = match ? `${match.spans[0].line}:${match.spans[0].column}:${match.url}` : null;
    if (key === this.hoveredLink) return;
    this.element.querySelector(':scope > .btm-wterm-url')?.remove();
    this.hoveredLink = key;
    this.element.classList.toggle('btm-wterm-url-hover', !!match);
    const cell = this.measureCell();
    if (!match || !cell) return;
    const layer = document.createElement('div');
    layer.className = 'btm-wterm-url';
    for (const s of match.spans) {
      const div = document.createElement('div');
      div.style.cssText = `top:${s.line * cell.height}px;left:${s.column * cell.width}px;width:${s.length * cell.width}px;height:${cell.height}px`;
      layer.appendChild(div);
    }
    this.element.appendChild(layer);
  }

  private onMouseMove = (event: MouseEvent) => {
    this.pointer = { x: event.clientX, y: event.clientY, target: event.target };
    this.linkModifierHeld = linkModifier(event);
    this.updateUrlHover();
  };

  private onMouseLeave = () => {
    this.pointer = null;
    this.updateUrlHover();
  };

  private onLinkModifier = (event: Event) => {
    if (event instanceof KeyboardEvent) this.linkModifierHeld = linkModifier(event);
    if (this.pointer) this.updateUrlHover();
  };

  /** Modifier-click opens a plain-text URL instead of reaching the terminal. */
  private onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !linkModifier(event)) return;
    const match = this.urlAt(event.clientX, event.clientY, event.target);
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    this.swallowMouseUp = true;
    window.open(match.url, '_blank', 'noopener,noreferrer');
  };

  private onMouseUp = (event: MouseEvent) => {
    if (!this.swallowMouseUp) return;
    this.swallowMouseUp = false;
    event.stopPropagation();
  };

  resize(cols: number, rows: number) {
    if (cols !== this.cols || rows !== this.rows) this.wterm.resize(cols, rows);
  }

  onData(fn: (data: Uint8Array) => void) {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  onResize(fn: (cols: number, rows: number) => void) {
    this.resizeListeners.add(fn);
    return () => this.resizeListeners.delete(fn);
  }

  onScroll(fn: () => void) {
    this.element.addEventListener('scroll', fn, { passive: true });
    return () => this.element.removeEventListener('scroll', fn);
  }

  focus() {
    this.wterm.focus();
  }

  blur() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.element.contains(active)) active.blur();
  }

  setPaused(paused: boolean) {
    this.wterm.setRenderingPaused(paused);
  }

  setTheme(theme: Theme) {
    this.wterm.setThemeColors({
      foreground: rgb(theme.foreground, 0xd4d4d4),
      background: rgb(theme.background, 0x1e1e1e),
      cursor: rgb(theme.cursor ?? theme.foreground, 0xd4d4d4),
      palette: ANSI_KEYS.map((k) => rgb(theme[k], 0)),
    });
    this.element.style.setProperty('--term-selection-bg', theme.selectionBackground ?? 'rgb(80 140 255 / 30%)');
  }

  /** Unscaled cell size in CSS pixels, maintained by wterm. */
  measureCell(): { width: number; height: number } | null {
    const style = getComputedStyle(this.element);
    const width = parseFloat(style.getPropertyValue('--term-cell-width'));
    const height = parseFloat(style.getPropertyValue('--term-row-height'));
    return width > 0 && height > 0 ? { width, height } : null;
  }

  /** Grid that fits the host element. */
  proposeDimensions(): { cols: number; rows: number } | null {
    const cell = this.measureCell();
    const rect = this.element.getBoundingClientRect();
    if (!cell || rect.width <= 0 || rect.height <= 0) return null;
    return {
      cols: Math.max(1, Math.floor(rect.width / cell.width)),
      rows: Math.max(1, Math.floor(rect.height / cell.height)),
    };
  }

  usingAltScreen() {
    return this.core.usingAltScreen();
  }

  mouseTracking() {
    return this.core.mouseTracking?.() ?? 0;
  }

  cursor() {
    return this.core.getCursor();
  }

  private isScrolledToBottom() {
    const el = this.element;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
  }

  scrollToBottom() {
    this.element.scrollTop = this.element.scrollHeight;
  }

  scrollPages(pages: number) {
    this.element.scrollTop += pages * this.element.clientHeight;
  }

  /** Paste through wterm's input, as a real paste event would. */
  paste(text: string) {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    this.element
      .querySelector('textarea')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }

  private emit(data: string | Uint8Array) {
    if (this.inputDisabled) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (bytes.length) this.dataListeners.forEach((fn) => fn(bytes));
  }

  /** Retained rows: scrollback (oldest first) then the active screen. */
  get rowCount() {
    return this.core.getScrollbackCount() + this.rows;
  }

  /** Retained row index at the top of the viewport. */
  viewportTop() {
    const cell = this.measureCell();
    if (!cell) return this.rowCount - this.rows;
    return Math.min(this.rowCount - this.rows, Math.max(0, Math.floor(this.element.scrollTop / cell.height)));
  }

  readRow(row: number): TerminalRow {
    const core = this.core;
    const history = core.getScrollbackCount();
    let read: (col: number) => CellData;
    let len: number;
    let wrapped: boolean;
    if (row < history) {
      const offset = history - 1 - row;
      len = core.getScrollbackLineLen(offset);
      read = (col) => core.getScrollbackCell(offset, col);
      wrapped = core.getScrollbackRowMetadata?.(offset)?.continuesPrevious ?? false;
    } else {
      const live = row - history;
      len = this.cols;
      read = (col) => core.getCell(live, col);
      wrapped = core.getRowMetadata?.(live)?.continuesPrevious ?? false;
    }
    let text = '';
    const cols: number[] = [];
    for (let x = 0; x < len; x++) {
      const cell = read(x);
      // Width 0 is the spacer half of a wide character.
      if (cell.width === 0 || cell.spacerHead) continue;
      const ch = cellText(cell);
      text += ch;
      for (let i = 0; i < ch.length; i++) cols.push(x);
    }
    return { text, cols, wrapped };
  }

  /** Active screen (alternate when in use) plus scrollback, as plain lines. */
  readLines(): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.rowCount; y++) lines.push(this.readRow(y).text.trimEnd());
    return lines;
  }

  /** Smart case: case-sensitive only if the query has an uppercase letter. */
  search(query: string) {
    this.wterm.search(query, { caseSensitive: query !== query.toLowerCase() });
  }

  findNext() {
    return this.wterm.findNext();
  }

  findPrevious() {
    return this.wterm.findPrevious();
  }

  onSearchChange(fn: ((state: SearchState) => void) | null) {
    this.wterm.onSearchChange = fn;
  }

  /** Highlight cells; `line` is a retained row index. */
  setDecorations(cells: { line: number; column: number; length: number; background: string }[]) {
    this.clearDecorations();
    const cell = this.measureCell();
    if (!cell || cells.length === 0) return;
    const layer = document.createElement('div');
    layer.className = 'btm-wterm-decorations';
    for (const c of cells) {
      const div = document.createElement('div');
      div.style.cssText = `position:absolute;top:${c.line * cell.height}px;left:${c.column * cell.width}px;width:${c.length * cell.width}px;height:${cell.height}px;background:${c.background}`;
      layer.appendChild(div);
    }
    this.element.appendChild(layer);
  }

  clearDecorations() {
    this.element.querySelector(':scope > .btm-wterm-decorations')?.remove();
  }

  setTransparent(transparent: boolean) {
    this.element.classList.toggle('btm-wterm-transparent', transparent);
  }

  dispose() {
    this.element.removeEventListener('wheel', this.onWheel, true);
    this.element.removeEventListener('mousedown', this.onMouseDown, true);
    this.element.removeEventListener('mouseup', this.onMouseUp, true);
    this.element.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('mouseleave', this.onMouseLeave);
    this.element.removeEventListener('scroll', this.onLinkModifier);
    document.removeEventListener('keydown', this.onLinkModifier, true);
    document.removeEventListener('keyup', this.onLinkModifier, true);
    this.dataListeners.clear();
    this.resizeListeners.clear();
    this.wterm.destroy();
    // wterm doesn't own a supplied core.
    this.core.dispose();
    this.element.remove();
  }
}
