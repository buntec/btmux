// Neovim `ext_multigrid` model and Canvas2D renderer: one canvas per grid.

interface HlAttr {
  foreground?: number;
  background?: number;
  special?: number;
  reverse?: boolean;
  italic?: boolean;
  bold?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
  /** 'winblend'/'pumblend' of float cells, 0–100. */
  blend?: number;
}

interface ModeInfo {
  cursor_shape?: 'block' | 'horizontal' | 'vertical';
  cell_percentage?: number;
  attr_id?: number;
  /** 'guicursor' blink times in ms; any of them 0 (or unset) disables blinking. */
  blinkwait?: number;
  blinkon?: number;
  blinkoff?: number;
}

export interface GridFont {
  family: string;
  size: number;
  /** CSS weight of regular text (bold is 700, as in terminal panes). */
  weight?: number;
  /** All text bold or italic ('guifont' `:b`, `:i`). */
  bold?: boolean;
  italic?: boolean;
  /** CSS pixels added to the cell width ('guifont' `:w`). */
  widthOffset?: number;
  /** Extra CSS pixels between rows ('linespace'). */
  linespace?: number;
  /** Fallback colors until Neovim sends `default_colors_set`. */
  foreground: string;
  background: string;
  transparent?: boolean;
  /** Opacity of colored cell backgrounds over a transparent surface, 0–1. */
  cellOpacity?: number;
}

/** A visible floating window, for the UI to frame. */
export interface FloatFrame {
  grid: number;
  /** Window handle (msgpack ext). */
  win: unknown;
  /** CSS-pixel box of the float's content (border cropped), relative to the surface. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Stacking position among floats, bottom first. */
  order: number;
  /** Neovim draws a border here; the frame replaces it. */
  border: boolean;
  /** The cursor is in this float. */
  focused: boolean;
  /** 'winblend', 0–100: how transparent the background is. */
  blend: number;
}

/** z-index of window canvases; floats stack above, below btmux widgets (z-40). */
const WINDOW_Z = 1;
const FLOAT_Z = 10;
const FLOAT_Z_MAX = 38;

/** Scrolls of a whole region or more animate only this many rows, like Neovide's far lines. */
const FAR_SCROLL_ROWS = 1;

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

const decorated = (a: HlAttr) =>
  a.underline || a.undercurl || a.underdouble || a.underdotted || a.underdashed || a.strikethrough;

const printableAscii = (text: string) => text.length === 1 && text >= ' ' && text <= '~';

// Box drawing and block elements drawn to the cell edges, as terminal panes (wterm)
// do, so lines connect across rows and 'linespace' leaves no gaps.
/** Arms of lines: up, down, left, right. */
const LIGHT_ARMS: Record<number, string> = {
  0x2500: 'lr',
  0x2502: 'ud',
  0x250c: 'dr',
  0x2510: 'dl',
  0x2514: 'ur',
  0x2518: 'ul',
  0x251c: 'udr',
  0x2524: 'udl',
  0x252c: 'dlr',
  0x2534: 'ulr',
  0x253c: 'udlr',
  0x2574: 'l',
  0x2575: 'u',
  0x2576: 'r',
  0x2577: 'd',
};
const HEAVY_ARMS: Record<number, string> = {
  0x2501: 'lr',
  0x2503: 'ud',
  0x250f: 'dr',
  0x2513: 'dl',
  0x2517: 'ur',
  0x251b: 'ul',
  0x2523: 'udr',
  0x252b: 'udl',
  0x2533: 'dlr',
  0x253b: 'ulr',
  0x254b: 'udlr',
  0x2578: 'l',
  0x2579: 'u',
  0x257a: 'r',
  0x257b: 'd',
};
/** Rounded corners: the arms their arc joins. */
const ARCS: Record<number, string> = { 0x256d: 'dr', 0x256e: 'dl', 0x256f: 'ul', 0x2570: 'ur' };
/** Quadrant blocks: top-left 1, top-right 2, bottom-left 4, bottom-right 8. */
const QUADRANTS: Record<number, number> = {
  0x2596: 4,
  0x2597: 8,
  0x2598: 1,
  0x2599: 13,
  0x259a: 9,
  0x259b: 7,
  0x259c: 11,
  0x259d: 2,
  0x259e: 6,
  0x259f: 14,
};
const SHADES: Record<number, number> = { 0x2591: 0.25, 0x2592: 0.5, 0x2593: 0.75 };

/** Filled parts of a block element, as [left, top, right, bottom] in eighths of the cell. */
function blockRects(cp: number): number[][] | null {
  if (cp === 0x2580) return [[0, 0, 8, 4]];
  if (cp >= 0x2581 && cp <= 0x2588) return [[0, 0x2588 - cp, 8, 8]];
  if (cp >= 0x2589 && cp <= 0x258f) return [[0, 0, 0x2590 - cp, 8]];
  if (cp === 0x2590) return [[4, 0, 8, 8]];
  if (cp === 0x2594) return [[0, 0, 8, 1]];
  if (cp === 0x2595) return [[7, 0, 8, 8]];
  const q = QUADRANTS[cp];
  if (!q) return null;
  const quadrants = [
    [0, 0, 4, 4],
    [4, 0, 8, 4],
    [0, 4, 4, 8],
    [4, 4, 8, 8],
  ];
  return quadrants.filter((_, i) => q & (1 << i));
}

/** Draw a box-drawing or block character natively; false for any other text. */
function drawCellArt(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fg: string,
  bold: boolean,
  dpr: number,
): boolean {
  const cp = text.length === 1 ? text.charCodeAt(0) : 0;
  if (cp < 0x2500 || cp > 0x259f) return false;
  ctx.fillStyle = fg;
  const shade = SHADES[cp];
  if (shade) {
    ctx.globalAlpha = shade;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    return true;
  }
  const rects = blockRects(cp);
  if (rects) {
    for (const [l, t, r, b] of rects) {
      const x0 = Math.round((l * w) / 8);
      const y0 = Math.round((t * h) / 8);
      ctx.fillRect(x + x0, y + y0, Math.round((r * w) / 8) - x0, Math.round((b * h) / 8) - y0);
    }
    return true;
  }
  const heavy = HEAVY_ARMS[cp];
  const arc = ARCS[cp];
  const arms = LIGHT_ARMS[cp] ?? heavy ?? arc;
  if (!arms) return false;
  // wterm's stroke widths: thicker for heavy lines and bold text.
  const px = Math.max(1, Math.round(dpr));
  const t = heavy || bold ? Math.max(2 * px, Math.round(w * 0.3)) : Math.max(px, Math.round(w * 0.18));
  const vx = x + Math.floor((w - t) / 2);
  const hy = y + Math.floor((h - t) / 2);
  if (arc) {
    const cx = vx + t / 2;
    const cy = hy + t / 2;
    const ex = arms.includes('l') ? x : x + w;
    const ey = arms.includes('u') ? y : y + h;
    ctx.strokeStyle = fg;
    ctx.lineWidth = t;
    ctx.beginPath();
    ctx.moveTo(cx, ey);
    ctx.arcTo(cx, cy, ex, cy, Math.min(Math.abs(ex - cx), Math.abs(ey - cy)));
    ctx.lineTo(ex, cy);
    ctx.stroke();
    return true;
  }
  if (arms.includes('u')) ctx.fillRect(vx, y, t, hy + t - y);
  if (arms.includes('d')) ctx.fillRect(vx, hy, t, y + h - hy);
  if (arms.includes('l')) ctx.fillRect(x, hy, vx + t - x, t);
  if (arms.includes('r')) ctx.fillRect(vx, hy, x + w - vx, t);
  return true;
}

/** A `grid_scroll` region sliding from its old pixels to its new content. */
interface ScrollAnim {
  top: number;
  bot: number;
  left: number;
  right: number;
  /** The region as it was displayed when the scroll arrived. */
  snapshot: HTMLCanvasElement;
  /** Initial pixel offset of the new content (positive = displaced down). */
  from: number;
  start: number;
}

interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const NO_MARGINS: Margins = { top: 0, bottom: 0, left: 0, right: 0 };

/** One Neovim grid: cell contents, its canvases, and where it sits on the screen. */
class Layer {
  cols = 0;
  rows = 0;
  text: string[] = [];
  hlIds: Uint32Array = new Uint32Array(0);
  dirty = new Set<number>();
  /** Needs presenting even without dirty rows (a scroll ended an animation). */
  private stale = false;
  kind: 'root' | 'window' | 'float';
  /** Screen cell (grid 1) of the grid's top-left cell. */
  row = 0;
  col = 0;
  hidden: boolean;
  win: unknown = null;
  margins: Margins = NO_MARGINS;
  compindex = 0;
  /** z-index of the canvas; the cursor canvas takes it while the cursor is here. */
  z = 0;
  mouse = true;
  /** Placement or size changed since the last layout. */
  moved = true;
  // Visible canvas, composed each flush from the offscreen grid plus scroll animations and the cursor.
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private gridCanvas = document.createElement('canvas');
  private gctx: CanvasRenderingContext2D;
  private anims = new Map<string, ScrollAnim>();
  // Regions already snapshotted in the current redraw batch.
  private scrolledThisBatch = new Set<string>();
  private frame = 0;

  constructor(
    readonly id: number,
    private s: NvimGrid,
    canvas?: HTMLCanvasElement,
  ) {
    this.kind = canvas ? 'root' : 'window';
    this.hidden = !canvas;
    this.canvas = canvas ?? document.createElement('canvas');
    if (this.canvas.dataset) this.canvas.dataset.grid = String(id);
    this.ctx = this.canvas.getContext('2d')!;
    this.gctx = this.gridCanvas.getContext('2d')!;
    if (!canvas) {
      Object.assign(this.canvas.style, { position: 'absolute', display: 'none', pointerEvents: 'auto' });
    }
  }

  /** Grid cells hidden behind the UI's own frame (float borders). */
  get crop(): Margins {
    return this.kind === 'float' ? this.margins : NO_MARGINS;
  }

  get visible(): boolean {
    return !this.hidden;
  }

  /** Device-pixel x of a grid column, aligned to the screen grid. */
  x(col: number): number {
    const cw = this.s.cellWidth;
    return Math.round((this.col + col) * cw) - Math.round(this.col * cw);
  }

  resize(cols: number, rows: number) {
    const text = new Array<string>(cols * rows).fill(' ');
    const hlIds = new Uint32Array(cols * rows);
    for (let r = 0; r < Math.min(rows, this.rows); r++) {
      for (let c = 0; c < Math.min(cols, this.cols); c++) {
        text[r * cols + c] = this.text[r * this.cols + c];
        hlIds[r * cols + c] = this.hlIds[r * this.cols + c];
      }
    }
    this.cols = cols;
    this.rows = rows;
    this.anims.clear();
    this.text = text;
    this.hlIds = hlIds;
    this.moved = true;
    this.redrawAll();
  }

  line(row: number, colStart: number, cells: [string, number?, number?][]) {
    if (row >= this.rows) return;
    let col = colStart;
    let hlId = 0;
    for (const [text, id, repeat] of cells) {
      if (id !== undefined) hlId = id;
      for (let i = 0; i < (repeat ?? 1) && col < this.cols; i++, col++) {
        this.text[row * this.cols + col] = text;
        this.hlIds[row * this.cols + col] = hlId;
      }
    }
    this.dirty.add(row);
  }

  clear() {
    this.anims.clear();
    this.text.fill(' ');
    this.hlIds.fill(0);
    this.redrawAll();
  }

  scroll(top: number, bot: number, left: number, right: number, rows: number) {
    this.stale = true;
    this.beginScrollAnim(top, bot, left, right, rows);
    const copy = (dst: number, src: number) => {
      for (let c = left; c < right; c++) {
        this.text[dst * this.cols + c] = this.text[src * this.cols + c];
        this.hlIds[dst * this.cols + c] = this.hlIds[src * this.cols + c];
      }
      this.dirty.add(dst);
    };
    if (rows > 0) {
      for (let r = top; r < bot - rows; r++) copy(r, r + rows);
    } else {
      for (let r = bot - 1; r >= top - rows; r--) copy(r, r + rows);
    }
  }

  redrawAll() {
    for (let r = 0; r < this.rows; r++) this.dirty.add(r);
  }

  clearAnims() {
    this.anims.clear();
  }

  /** Size and place the canvases for the current grid size, position, and metrics. */
  layout(zIndex: number) {
    this.moved = false;
    if (this.kind === 'root') return;
    this.z = zIndex;
    const { cellWidth: cw, cellHeight: ch, dpr } = this.s;
    const crop = this.crop;
    const style = this.canvas.style;
    style.display = this.hidden ? 'none' : 'block';
    style.zIndex = String(zIndex);
    style.pointerEvents = this.mouse ? 'auto' : 'none';
    const gridW = this.x(this.cols);
    const gridH = this.rows * ch;
    const width = Math.max(0, this.x(this.cols - crop.right) - this.x(crop.left));
    const height = Math.max(0, (this.rows - crop.top - crop.bottom) * ch);
    if (this.gridCanvas.width !== gridW || this.gridCanvas.height !== gridH) {
      this.gridCanvas.width = gridW;
      this.gridCanvas.height = gridH;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    style.left = `${Math.round((this.col + crop.left) * cw) / dpr}px`;
    style.top = `${((this.row + crop.top) * ch) / dpr}px`;
    style.width = `${width / dpr}px`;
    style.height = `${height / dpr}px`;
    this.anims.clear();
    this.redrawAll();
  }

  /** 'winblend' of the window, which Neovim applies to every cell's highlight. */
  blend(): number {
    const row = Math.min(this.crop.top, this.rows - 1);
    const id = this.hlIds[row * this.cols + Math.min(this.crop.left, this.cols - 1)];
    return this.s.attr(id)?.blend ?? 0;
  }

  /** Root only: fit both canvases to the surface. */
  resizeCanvas(width: number, height: number) {
    this.canvas.width = Math.round(width * this.s.dpr);
    this.canvas.height = Math.round(height * this.s.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gridCanvas.width = this.canvas.width;
    this.gridCanvas.height = this.canvas.height;
    this.anims.clear();
    this.redrawAll();
  }

  /** Repaint dirty rows and present the frame, unless nothing on it changed. */
  flush() {
    if (!this.dirty.size && !this.anims.size && !this.stale) return;
    this.stale = false;
    if (this.kind === 'root') {
      // Clear the margin outside the grid before repainting opaque defaults.
      const ctx = this.gctx;
      const { cellHeight } = this.s;
      ctx.fillStyle = this.s.colors(0, false).bg;
      const gridW = this.x(this.cols);
      const gridH = this.rows * cellHeight;
      ctx.clearRect(gridW, 0, this.canvas.width - gridW, this.canvas.height);
      ctx.clearRect(0, gridH, this.canvas.width, this.canvas.height - gridH);
      if (!this.s.colors(0, false).transparent) {
        ctx.fillRect(gridW, 0, this.canvas.width - gridW, this.canvas.height);
        ctx.fillRect(0, gridH, this.canvas.width, this.canvas.height - gridH);
      }
    }
    for (const row of this.dirty) if (row < this.rows) this.drawRow(row);
    this.dirty.clear();
    this.scrolledThisBatch.clear();
    this.present();
  }

  /** Remaining pixel offset of a scroll animation (ease-out cubic). */
  private animOffset(anim: ScrollAnim, now: number): number {
    const duration = this.s.smoothScroll;
    const t = duration > 0 ? Math.min(1, (now - anim.start) / duration) : 1;
    return Math.round(anim.from * (1 - t) ** 3);
  }

  /** Snapshot a region before Neovim scrolls it, so the move can be animated. */
  private beginScrollAnim(top: number, bot: number, left: number, right: number, rows: number) {
    if (this.s.smoothScroll <= 0 || this.hidden) return;
    const ch = this.s.cellHeight;
    const key = `${top}:${bot}:${left}:${right}`;
    const height = (bot - top) * ch;
    const delta = rows * ch;
    const existing = this.anims.get(key);
    // A second scroll before the flush: the displayed pixels haven't changed.
    // Far scrolls show their last rows sliding in.
    const far = (from: number) =>
      Math.abs(from) >= height ? Math.sign(from) * Math.min(FAR_SCROLL_ROWS * ch, height) : from;
    if (existing && this.scrolledThisBatch.has(key)) {
      existing.from = far(existing.from + delta);
      return;
    }
    const now = performance.now();
    const residual = existing ? this.animOffset(existing, now) : 0;
    const from = far(delta + residual);
    // Capture what is on screen now.
    this.compose(now);
    const [ox, oy] = this.origin();
    const x0 = this.x(left);
    const width = this.x(right) - x0;
    const snapshot = existing?.snapshot ?? document.createElement('canvas');
    snapshot.width = width;
    snapshot.height = height;
    snapshot.getContext('2d')!.drawImage(this.canvas, x0 - ox, top * ch - oy, width, height, 0, 0, width, height);
    this.anims.set(key, { top, bot, left, right, snapshot, from, start: now });
    this.scrolledThisBatch.add(key);
  }

  /** Device-pixel offset of the visible canvas within the grid. */
  private origin(): [number, number] {
    const crop = this.crop;
    return [this.x(crop.left), crop.top * this.s.cellHeight];
  }

  /** Draw the current frame, and keep animating while scrolls are in flight. */
  present() {
    if (this.hidden) return;
    this.compose(performance.now());
    if (this.anims.size && !this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.present();
        // The cursor follows scrolls of its region.
        if (this.s.cursor.grid === this.id) this.s.drawCursor();
      });
    }
  }

  /** Remaining scroll animation offset of a cell, for the cursor. */
  scrollOffset(row: number, col: number, now: number): number {
    for (const anim of this.anims.values()) {
      if (row >= anim.top && row < anim.bot && col >= anim.left && col < anim.right) return this.animOffset(anim, now);
    }
    return 0;
  }

  /** Device-pixel box of the visible canvas on the surface. */
  box(): { left: number; top: number; right: number; bottom: number } {
    const { cellWidth: cw, cellHeight: ch } = this.s;
    const crop = this.crop;
    return {
      left: Math.round((this.col + crop.left) * cw),
      top: (this.row + crop.top) * ch,
      right: Math.round((this.col + this.cols - crop.right) * cw),
      bottom: (this.row + this.rows - crop.bottom) * ch,
    };
  }

  private compose(now: number) {
    const ctx = this.ctx;
    const ch = this.s.cellHeight;
    const [ox, oy] = this.origin();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.gridCanvas, -ox, -oy);
    for (const [key, anim] of this.anims) {
      const d = this.animOffset(anim, now);
      // Finished: the plain grid blit above already shows the final position.
      if (d === 0 && !this.scrolledThisBatch.has(key)) {
        this.anims.delete(key);
        continue;
      }
      const gx = this.x(anim.left);
      const width = this.x(anim.right) - gx;
      const gy = anim.top * ch;
      const height = (anim.bot - anim.top) * ch;
      const x0 = gx - ox;
      const y0 = gy - oy;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, width, height);
      ctx.clip();
      ctx.clearRect(x0, y0, width, height);
      // Keep old pixels only in the departing strip; transparent new cells
      // must not reveal the previous frame's text beneath them.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, d > 0 ? y0 : y0 + height + d, width, Math.abs(d));
      ctx.clip();
      ctx.drawImage(anim.snapshot, x0, y0 + d - anim.from);
      ctx.restore();
      ctx.drawImage(this.gridCanvas, gx, gy, width, height, x0, y0 + d, width, height);
      ctx.restore();
    }
  }

  private drawRow(row: number) {
    const ctx = this.gctx;
    const ch = this.s.cellHeight;
    const y = row * ch;
    const base = row * this.cols;
    const float = this.kind === 'float';
    // Clip so glyphs that overflow their cell can't leave residue in neighboring rows.
    ctx.save();
    ctx.beginPath();
    const gridW = this.x(this.cols);
    ctx.rect(0, y, gridW, ch);
    ctx.clip();
    ctx.clearRect(0, y, gridW, ch);
    // Backgrounds, in runs of equal highlight.
    let start = 0;
    while (start < this.cols) {
      const id = this.hlIds[base + start];
      let end = start + 1;
      while (end < this.cols && this.hlIds[base + end] === id) end++;
      const colors = this.s.colors(id, float);
      ctx.fillStyle = colors.bg;
      // Blend backgrounds only; text stays opaque, as on a translucent card.
      ctx.globalAlpha = float ? 1 - (colors.attr.blend ?? 0) / 100 : this.s.cellOpacity;
      const x0 = this.x(start);
      if (!colors.transparent) ctx.fillRect(x0, y, this.x(end) - x0, ch);
      start = end;
    }
    ctx.globalAlpha = 1;
    // Glyphs. Runs of printable ASCII in one highlight share a fillText, so the font
    // can join ligatures; other cells are drawn alone to keep grid alignment.
    ctx.textBaseline = 'alphabetic';
    let runStart = -1;
    const endRun = (end: number) => {
      if (runStart < 0) return;
      const text = this.text.slice(base + runStart, base + end).join('');
      if (text.trim()) {
        const { fg, attr } = this.s.colors(this.hlIds[base + runStart], float);
        this.drawGlyph(ctx, text, this.x(runStart), y, fg, attr);
      }
      runStart = -1;
    };
    for (let col = 0; col < this.cols; col++) {
      const text = this.text[base + col];
      const id = this.hlIds[base + col];
      if (this.s.monospace && printableAscii(text)) {
        if (runStart >= 0 && id !== this.hlIds[base + runStart]) endRun(col);
        if (runStart < 0) runStart = col;
        continue;
      }
      endRun(col);
      if (!text || text === ' ') continue;
      const { fg, attr } = this.s.colors(id, float);
      this.drawCell(ctx, text, this.x(col), y, this.x(col + 1) - this.x(col), fg, attr);
    }
    endRun(this.cols);
    for (let col = 0; col < this.cols; col++) {
      const attr = this.s.attr(this.hlIds[base + col]);
      if (!attr || !decorated(attr)) continue;
      const { fg, sp } = this.s.colors(this.hlIds[base + col], float);
      this.drawDecorations(col, row, fg, sp, attr);
    }
    // Windows hide grid 1 beneath them, where Neovim leaves stale separators and
    // statuslines of closed windows; transparent window cells would show them.
    if (this.kind === 'root') {
      for (const win of this.s.covered) {
        if (row < win.row || row >= win.row + win.rows) continue;
        const x0 = this.x(win.col);
        ctx.clearRect(x0, y, this.x(win.col + win.cols) - x0, ch);
      }
    }
    ctx.restore();
  }

  private drawCell(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    w: number,
    fg: string,
    a: HlAttr,
  ) {
    const { cellHeight, dpr } = this.s;
    if (!drawCellArt(ctx, text, x, y, w, cellHeight, fg, !!a.bold, dpr)) this.drawGlyph(ctx, text, x, y, fg, a);
  }

  private drawGlyph(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fg: string, attr: HlAttr) {
    if (!text || text === ' ') return;
    ctx.font = this.s.fontString(!!attr.bold, !!attr.italic);
    ctx.fillStyle = fg;
    ctx.fillText(text, x, y + this.s.ascent);
  }

  private drawDecorations(col: number, row: number, fg: string, sp: string, attr: HlAttr) {
    const ctx = this.gctx;
    const { cellHeight, dpr } = this.s;
    const x = this.x(col);
    const w = this.x(col + 1) - x;
    const y = row * cellHeight;
    const thickness = Math.max(1, Math.round(dpr));
    if (attr.strikethrough) {
      ctx.fillStyle = fg;
      ctx.fillRect(x, y + Math.round(cellHeight / 2), w, thickness);
    }
    const underY = y + cellHeight - 2 * thickness;
    if (attr.undercurl) {
      ctx.strokeStyle = sp;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      const amp = 1.5 * thickness;
      for (let i = 0; i <= w; i += thickness) {
        const yy = underY + Math.sin(((x + i) / (3 * thickness)) * Math.PI) * amp;
        if (i === 0) ctx.moveTo(x + i, yy);
        else ctx.lineTo(x + i, yy);
      }
      ctx.stroke();
    } else if (attr.underline || attr.underdouble) {
      ctx.fillStyle = sp;
      ctx.fillRect(x, underY, w, thickness);
      if (attr.underdouble) ctx.fillRect(x, underY - 2 * thickness, w, thickness);
    } else if (attr.underdotted || attr.underdashed) {
      ctx.fillStyle = sp;
      const [on, period] = attr.underdotted ? [thickness, 2 * thickness] : [3 * thickness, 5 * thickness];
      // Segments follow the grid's x, so the pattern continues across cells.
      for (let s = x - (x % period); s < x + w; s += period) {
        const a = Math.max(s, x);
        const b = Math.min(s + on, x + w);
        if (b > a) ctx.fillRect(a, underY, b - a, thickness);
      }
    }
  }

  /** Draw the cursor cell with its top-left at device pixel (x, y) of `ctx`. */
  drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const { row, col } = this.s.cursor;
    const { cellHeight: ch, dpr } = this.s;
    const info = this.s.modeInfo();
    const idx = row * this.cols + col;
    const cell = this.s.colors(this.hlIds[idx], this.kind === 'float');
    const cursorAttr = info.attr_id ? this.s.attr(info.attr_id) : undefined;
    // attr_id 0 means "invert the cell".
    const cursorBg = cursorAttr?.background !== undefined ? hex(cursorAttr.background) : cell.fg;
    const cursorFg = cursorAttr?.foreground !== undefined ? hex(cursorAttr.foreground) : cell.bg;
    const wide = col + 1 < this.cols && this.text[idx + 1] === '';
    const w = this.x(col + (wide ? 2 : 1)) - this.x(col);
    const pct = (info.cell_percentage ?? 100) / 100;
    ctx.fillStyle = cursorBg;
    switch (info.cursor_shape) {
      case 'vertical':
        ctx.fillRect(x, y, Math.max(dpr, Math.round(w * pct)), ch);
        break;
      case 'horizontal': {
        const h = Math.max(dpr, Math.round(ch * pct));
        ctx.fillRect(x, y + ch - h, w, h);
        break;
      }
      default:
        if (!this.s.focused) {
          // Unfocused, the block is an outline, as in GUI Vims.
          const t = Math.max(1, Math.round(dpr));
          ctx.fillRect(x, y, w, t);
          ctx.fillRect(x, y + ch - t, w, t);
          ctx.fillRect(x, y, t, ch);
          ctx.fillRect(x + w - t, y, t, ch);
          break;
        }
        ctx.fillRect(x, y, w, ch);
        if (this.text[idx] && this.text[idx] !== ' ') {
          this.drawCell(ctx, this.text[idx], x, y, this.x(col + 1) - this.x(col), cursorFg, cell.attr);
        }
    }
  }
}

export class NvimGrid {
  private layers = new Map<number, Layer>();
  private root: Layer;
  private hl = new Map<number, HlAttr>();
  // Highlight ids of UI groups (`hl_group_set`), e.g. NormalFloat.
  private groups = new Map<string, number>();
  private fg: string;
  private bg: string;
  private sp: string;
  /** Grid and cell of the cursor. */
  cursor = { grid: 1, row: 0, col: 0 };
  private modes: ModeInfo[] = [];
  private mode = 0;
  private busy = false;
  private nvimDefaults = { fg: -1, bg: -1, sp: -1 };
  // Fields of the Normal group; unset ones fall back to the btmux theme, like a TUI.
  private normal = { fg: false, bg: false, sp: false };
  private floatsKey = '';
  /** @internal Screen cells of visible windows. */
  covered: { row: number; col: number; rows: number; cols: number }[] = [];
  private coveredKey = '';
  /** Called when Neovim's default colors change, to re-query Normal. */
  onDefaultColors: (() => void) | null = null;
  /** Receives events the grid doesn't handle (cmdline, popupmenu, …). */
  onEvent: ((name: string, args: unknown[]) => void) | null = null;
  /** Called after each `flush` is drawn. */
  onFlush: (() => void) | null = null;
  /** Called when the visible floats change. */
  onFloats: ((floats: FloatFrame[]) => void) | null = null;
  /** Hide the grid cursor, e.g. while an external cmdline owns it. */
  cursorHidden = false;
  // The cursor as of the last flush.
  private cursorKey = '';
  private hasFocus = true;
  private blinkOff = false;
  private blinkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Scroll animation length in ms; 0 scrolls instantly. */
  smoothScroll = 0;
  /** Cursor movement animation length in ms; 0 jumps. */
  cursorAnimation = 0;
  // The cursor has its own canvas, above the window it's in, so it can travel between windows.
  private cursorCanvas: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  // Where the cursor was last placed (device pixels, without scroll offsets), and where a move started.
  private cursorAt: { grid: number; x: number; y: number } | null = null;
  private cursorMove: { grid: number; x: number; y: number; start: number } | null = null;
  private cursorFrame = 0;

  cellWidth = 1;
  cellHeight = 1;
  ascent = 1;
  dpr = 1;
  /** @internal Every glyph advances one cell width; proportional fonts are drawn cell by cell. */
  monospace = true;
  private font: GridFont;
  private measureCtx: CanvasRenderingContext2D;

  /**
   * `canvas` shows grid 1 (statuslines, separators) and fills the surface; window
   * and float canvases are added to `host`, which should not intercept the mouse.
   */
  constructor(
    canvas: HTMLCanvasElement,
    font: GridFont,
    private host: HTMLElement | null = null,
  ) {
    this.font = font;
    this.fg = font.foreground;
    this.bg = font.background;
    this.sp = font.foreground;
    this.root = new Layer(1, this, canvas);
    this.layers.set(1, this.root);
    this.cursorCanvas = document.createElement('canvas');
    this.cctx = this.cursorCanvas.getContext('2d')!;
    Object.assign(this.cursorCanvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
    host?.appendChild(this.cursorCanvas);
    this.measureCtx = document.createElement('canvas').getContext('2d')!;
    this.measure();
  }

  get cols(): number {
    return this.root.cols;
  }

  get rows(): number {
    return this.root.rows;
  }

  setFont(font: GridFont) {
    this.font = font;
    this.measure();
    this.cursorAt = null;
    this.cursorMove = null;
    for (const layer of this.layers.values()) {
      layer.clearAnims();
      layer.moved = true;
    }
    this.updateDefaults();
    this.flush();
  }

  /** Device-pixel cell metrics for the current font and DPR. */
  measure() {
    this.dpr = window.devicePixelRatio || 1;
    this.measureCtx.font = this.fontString(false, false);
    const m = this.measureCtx.measureText('M');
    const offset = (this.font.widthOffset ?? 0) * this.dpr;
    this.cellWidth = Math.max(1, m.width + offset);
    // Runs advance by glyph widths, so a width offset needs cell-by-cell drawing too.
    this.monospace =
      offset === 0 &&
      ['i', 'W', '=', ' '].every((c) => Math.abs(this.measureCtx.measureText(c).width - m.width) < 0.01);
    const ascent = m.fontBoundingBoxAscent ?? this.font.size * this.dpr * 0.8;
    const descent = m.fontBoundingBoxDescent ?? this.font.size * this.dpr * 0.2;
    const linespace = (this.font.linespace ?? 0) * this.dpr;
    this.cellHeight = Math.ceil(ascent + descent + linespace);
    // Split the extra space above and below the glyphs.
    this.ascent = Math.round(ascent + linespace / 2);
  }

  /** Grid size that fits `width`×`height` CSS pixels. */
  fit(width: number, height: number): [number, number] {
    const cols = Math.max(1, Math.floor((width * this.dpr) / this.cellWidth));
    const rows = Math.max(1, Math.floor((height * this.dpr) / this.cellHeight));
    return [cols, rows];
  }

  resizeCanvas(width: number, height: number) {
    this.root.resizeCanvas(width, height);
    this.cursorCanvas.width = Math.round(width * this.dpr);
    this.cursorCanvas.height = Math.round(height * this.dpr);
    this.cursorCanvas.style.width = `${width}px`;
    this.cursorCanvas.style.height = `${height}px`;
    this.cursorAt = null;
    this.cursorMove = null;
    this.flush();
  }

  /** Screen cell under a CSS-pixel offset within the surface. */
  cellAt(x: number, y: number): [number, number] {
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((y * this.dpr) / this.cellHeight)));
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((x * this.dpr) / this.cellWidth)));
    return [row, col];
  }

  /** The grid whose canvas is (or contains) `target`, if any. */
  gridAt(target: EventTarget | null): number | null {
    const canvas = (target as Element | null)?.closest?.('canvas[data-grid]') as HTMLCanvasElement | null;
    const id = canvas ? Number(canvas.dataset.grid) : NaN;
    return this.layers.has(id) ? id : null;
  }

  /** Cell of `grid` under a client-space point, clamped to the grid. */
  cellIn(grid: number, clientX: number, clientY: number): [number, number] {
    const layer = this.layers.get(grid);
    if (!layer) return [0, 0];
    const rect = layer.canvas.getBoundingClientRect();
    const crop = layer.crop;
    const x = (clientX - rect.left) * this.dpr + Math.round((layer.col + crop.left) * this.cellWidth);
    const row = Math.floor(((clientY - rect.top) * this.dpr) / this.cellHeight) + crop.top;
    const col = Math.floor(x / this.cellWidth) - layer.col;
    return [Math.min(layer.rows - 1, Math.max(0, row)), Math.min(layer.cols - 1, Math.max(0, col))];
  }

  /** Screen cell of a cell in `grid`. */
  screenCell(grid: number, row: number, col: number): [number, number] {
    const layer = this.layers.get(grid);
    return layer ? [layer.row + row, layer.col + col] : [row, col];
  }

  /** CSS-pixel box of the cursor cell. */
  cursorRect(): { left: number; top: number; height: number } {
    return this.cellRect(...this.screenCell(this.cursor.grid, this.cursor.row, this.cursor.col));
  }

  /** Text and highlight id of a cell ("" for the right half of a wide character). */
  cell(row: number, col: number, grid = 1): { text: string; hl: number } {
    const layer = this.layers.get(grid)!;
    const i = row * layer.cols + col;
    return { text: layer.text[i], hl: layer.hlIds[i] };
  }

  /** CSS-pixel box of a screen cell, for anchoring external widgets. */
  cellRect(row: number, col: number): { left: number; top: number; height: number } {
    return {
      left: Math.round(col * this.cellWidth) / this.dpr,
      top: (row * this.cellHeight) / this.dpr,
      height: this.cellHeight / this.dpr,
    };
  }

  /** Resolved colors and styles of a highlight attribute id. */
  attrStyle(id: number): { color?: string; background?: string; bold?: boolean; italic?: boolean } {
    const attr = this.hl.get(id);
    if (!id || !attr) return {};
    let color = attr.foreground !== undefined ? hex(attr.foreground) : undefined;
    let background = attr.background !== undefined ? hex(attr.background) : undefined;
    if (attr.reverse) [color, background] = [background ?? this.bg, color ?? this.fg];
    return { color, background, bold: attr.bold, italic: attr.italic };
  }

  /** Apply one `redraw` notification's batch of events. */
  redraw(batch: unknown[]) {
    for (const event of batch as [string, ...unknown[][]][]) {
      const [name, ...calls] = event;
      for (const args of calls) this.apply(name, args);
    }
  }

  private layer(id: number): Layer {
    let layer = this.layers.get(id);
    if (!layer) {
      layer = new Layer(id, this);
      this.layers.set(id, layer);
      this.host?.insertBefore(layer.canvas, this.cursorCanvas);
    }
    return layer;
  }

  private apply(name: string, args: unknown[]) {
    switch (name) {
      case 'grid_resize': {
        const [grid, cols, rows] = args as number[];
        this.layer(grid).resize(cols, rows);
        break;
      }
      case 'default_colors_set': {
        const [fg, bg, sp] = args as number[];
        this.nvimDefaults = { fg, bg, sp };
        this.updateDefaults();
        this.onDefaultColors?.();
        break;
      }
      case 'hl_attr_define': {
        const [id, attrs] = args as [number, HlAttr];
        this.hl.set(id, attrs);
        break;
      }
      case 'hl_group_set': {
        const [group, id] = args as [string, number];
        this.groups.set(group, id);
        if (group === 'NormalFloat') this.redrawAll();
        this.onEvent?.(name, args);
        break;
      }
      case 'grid_line': {
        const [grid, row, colStart, cells] = args as [number, number, number, [string, number?, number?][]];
        this.layers.get(grid)?.line(row, colStart, cells);
        break;
      }
      case 'grid_clear':
        this.layers.get(args[0] as number)?.clear();
        break;
      case 'grid_destroy': {
        const [grid] = args as number[];
        const layer = this.layers.get(grid);
        if (layer && layer !== this.root) {
          layer.canvas.remove();
          this.layers.delete(grid);
        }
        break;
      }
      case 'grid_cursor_goto': {
        const [grid, row, col] = args as number[];
        this.cursor = { grid, row, col };
        break;
      }
      case 'grid_scroll': {
        const [grid, top, bot, left, right, rows] = args as number[];
        this.layers.get(grid)?.scroll(top, bot, left, right, rows);
        break;
      }
      case 'win_pos': {
        const [grid, win, row, col] = args as [number, unknown, number, number];
        this.place(grid, { kind: 'window', win, row, col, hidden: false, mouse: true });
        break;
      }
      case 'win_float_pos': {
        const [grid, win, , , , , mouse, , compindex, row, col] = args as [
          number,
          unknown,
          string,
          number,
          number,
          number,
          boolean,
          number,
          number,
          number,
          number,
        ];
        this.place(grid, { kind: 'float', win, row, col, compindex, mouse, hidden: false });
        break;
      }
      case 'win_hide':
      case 'win_close':
        this.place(args[0] as number, { hidden: true });
        break;
      case 'win_viewport_margins': {
        const [grid, , top, bottom, left, right] = args as number[];
        this.place(grid, { margins: { top, bottom, left, right } });
        break;
      }
      case 'win_viewport':
      case 'win_extmark':
        break;
      case 'mode_info_set': {
        const [, infos] = args as [boolean, ModeInfo[]];
        this.modes = infos;
        break;
      }
      case 'mode_change': {
        const [, idx] = args as [string, number];
        this.mode = idx;
        break;
      }
      case 'busy_start':
        this.busy = true;
        break;
      case 'busy_stop':
        this.busy = false;
        break;
      case 'flush':
        this.flush();
        this.onFlush?.();
        break;
      default:
        this.onEvent?.(name, args);
    }
  }

  private place(
    grid: number,
    changes: Partial<Pick<Layer, 'kind' | 'win' | 'row' | 'col' | 'hidden' | 'mouse' | 'compindex' | 'margins'>>,
  ) {
    if (grid === 1) return;
    const layer = this.layer(grid);
    for (const [key, value] of Object.entries(changes) as [keyof typeof changes, never][]) {
      if (JSON.stringify(layer[key]) !== JSON.stringify(value)) {
        layer[key] = value;
        layer.moved = true;
      }
    }
  }

  /** Keyboard focus: unfocused, the block cursor is an outline and doesn't blink. */
  setFocused(focused: boolean) {
    if (focused === this.hasFocus) return;
    this.hasFocus = focused;
    this.flush();
  }

  dispose() {
    clearTimeout(this.blinkTimer);
    cancelAnimationFrame(this.cursorFrame);
  }

  /** Device-pixel cell origin of the cursor on the surface, or null while its grid isn't shown. */
  private cursorTarget(): { layer: Layer; x: number; y: number } | null {
    const layer = this.layers.get(this.cursor.grid);
    const { row, col } = this.cursor;
    if (!layer || layer.hidden || row >= layer.rows || col >= layer.cols) return null;
    return { layer, x: Math.round((layer.col + col) * this.cellWidth), y: (layer.row + row) * this.cellHeight };
  }

  /** Animate the cursor from where it is drawn to its new cell. */
  private startCursorMove() {
    const target = this.cursorTarget();
    const from = this.cursorAt;
    if (!target || !from || this.cursorAnimation <= 0) {
      this.cursorMove = null;
      return;
    }
    // A mode or focus change: keep any move in flight.
    if (from.x === target.x && from.y === target.y) return;
    // Typing moves a cell or two along the row; those jump.
    const short = from.y === target.y && Math.abs(from.x - target.x) <= 2 * this.cellWidth + 1;
    this.cursorMove = short ? null : { ...from, start: performance.now() };
  }

  /** @internal Draw the cursor on its canvas, a frame of its move if one is in flight. */
  drawCursor() {
    const ctx = this.cctx;
    ctx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
    const target = this.cursorTarget();
    if (!target) {
      this.cursorAt = null;
      this.cursorMove = null;
      return;
    }
    const now = performance.now();
    let { x, y } = target;
    const move = this.cursorMove;
    if (move) {
      const t = this.cursorAnimation > 0 ? Math.min(1, (now - move.start) / this.cursorAnimation) : 1;
      const k = (1 - t) ** 3;
      x = Math.round(x + (move.x - x) * k);
      y = Math.round(y + (move.y - y) * k);
      if (t >= 1) this.cursorMove = null;
      else if (!this.cursorFrame) {
        this.cursorFrame = requestAnimationFrame(() => {
          this.cursorFrame = 0;
          this.drawCursor();
        });
      }
    }
    this.cursorAt = { grid: this.cursorMove?.grid ?? this.cursor.grid, x, y };
    if (this.cursorSuppressed || this.blinkOff) return;
    const { layer } = target;
    this.cursorCanvas.style.zIndex = String(layer.z);
    ctx.save();
    // Only moves between windows may leave the cursor's window.
    if (!this.cursorMove || this.cursorMove.grid === layer.id) {
      const box = layer.box();
      ctx.beginPath();
      ctx.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      ctx.clip();
    }
    layer.drawCursor(ctx, x, y + layer.scrollOffset(this.cursor.row, this.cursor.col, now));
    ctx.restore();
  }

  /** Show the cursor and restart its 'guicursor' blink cycle. */
  private restartBlink() {
    clearTimeout(this.blinkTimer);
    this.blinkOff = false;
    const { blinkwait, blinkon, blinkoff } = this.modeInfo();
    if (!this.hasFocus || !blinkwait || !blinkon || !blinkoff) return;
    const next = (delay: number) => {
      this.blinkTimer = setTimeout(() => {
        this.blinkOff = !this.blinkOff;
        this.drawCursor();
        next(this.blinkOff ? blinkoff : blinkon);
      }, delay);
    };
    next(blinkwait);
  }

  /** Record which colors the Normal group sets (from `nvim_get_hl`). */
  setNormal(hl: { fg?: number; bg?: number; sp?: number }) {
    this.normal = { fg: hl.fg !== undefined, bg: hl.bg !== undefined, sp: hl.sp !== undefined };
    this.updateDefaults();
    this.flush();
  }

  private updateDefaults() {
    const d = this.nvimDefaults;
    this.fg = this.normal.fg && d.fg >= 0 ? hex(d.fg) : this.font.foreground;
    this.bg = this.normal.bg && d.bg >= 0 ? hex(d.bg) : this.font.background;
    this.sp = this.normal.sp && d.sp >= 0 ? hex(d.sp) : this.fg;
    this.redrawAll();
  }

  private redrawAll() {
    for (const layer of this.layers.values()) layer.redrawAll();
  }

  /** @internal */
  fontString(bold: boolean, italic: boolean) {
    const weight = bold || this.font.bold ? 'bold' : (this.font.weight ?? 400);
    const style = italic || this.font.italic ? 'italic ' : '';
    return `${style}${weight} ${this.font.size * this.dpr}px ${this.font.family}`;
  }

  /** @internal */
  attr(id: number): HlAttr | undefined {
    return this.hl.get(id);
  }

  /** @internal */
  modeInfo(): ModeInfo {
    return this.modes[this.mode] ?? {};
  }

  /** @internal */
  get focused(): boolean {
    return this.hasFocus;
  }

  /** @internal In the off phase of a blink. */
  get cursorBlinkedOff(): boolean {
    return this.blinkOff;
  }

  /** @internal Whether the cursor is hidden altogether. */
  get cursorSuppressed(): boolean {
    return this.busy || this.cursorHidden;
  }

  /**
   * @internal Colors of a highlight. In floats, the NormalFloat background is left
   * transparent so the UI's frame shows through.
   */
  colors(hlId: number, float: boolean): { fg: string; bg: string; sp: string; attr: HlAttr; transparent: boolean } {
    const attr = this.hl.get(hlId) ?? {};
    let fg = attr.foreground !== undefined ? hex(attr.foreground) : this.fg;
    let bg = attr.background !== undefined ? hex(attr.background) : this.bg;
    if (attr.reverse) [fg, bg] = [bg, fg];
    const sp = attr.special !== undefined ? hex(attr.special) : this.sp;
    let transparent: boolean;
    if (float) {
      const floatBg = this.hl.get(this.groups.get('NormalFloat') ?? -1)?.background;
      transparent = !attr.reverse && (attr.background === undefined || attr.background === floatBg);
    } else {
      transparent = !!this.font.transparent && !this.normal.bg && attr.background === undefined && !attr.reverse;
    }
    return { fg, bg, sp, attr, transparent };
  }

  /** @internal Alpha of colored non-float cell backgrounds. */
  get cellOpacity(): number {
    if (!this.font.transparent || this.normal.bg) return 1;
    return Math.min(1, Math.max(0, this.font.cellOpacity ?? 1));
  }

  private flush() {
    const cursorKey = JSON.stringify([this.cursor, this.modeInfo(), this.cursorSuppressed, this.hasFocus]);
    const cursorChanged = cursorKey !== this.cursorKey;
    this.cursorKey = cursorKey;
    const floats = [...this.layers.values()]
      .filter((l) => l.kind === 'float' && l.visible)
      .sort((a, b) => a.compindex - b.compindex);
    const order = new Map(floats.map((l, i) => [l, i]));
    const covered = [...this.layers.values()]
      .filter((l) => l.kind === 'window' && l.visible)
      .map(({ row, col, rows, cols }) => ({ row, col, rows, cols }));
    const coveredKey = JSON.stringify(covered);
    if (coveredKey !== this.coveredKey) {
      this.covered = covered;
      this.coveredKey = coveredKey;
      this.root.redrawAll();
    }
    for (const layer of this.layers.values()) {
      if (layer.moved) {
        const i = order.get(layer);
        layer.layout(i === undefined ? WINDOW_Z : Math.min(FLOAT_Z_MAX, FLOAT_Z + 2 * i + 1));
      }
      layer.flush();
    }
    this.publishFloats(floats);
    if (cursorChanged) {
      this.restartBlink();
      this.startCursorMove();
    }
    // The block cursor shows its cell's text, which may have changed.
    this.drawCursor();
  }

  private publishFloats(floats: Layer[]) {
    const frames = floats.map((layer, order): FloatFrame => {
      const crop = layer.crop;
      const box = this.cellRect(layer.row + crop.top, layer.col + crop.left);
      const end = this.cellRect(layer.row + layer.rows - crop.bottom, layer.col + layer.cols - crop.right);
      return {
        grid: layer.id,
        win: layer.win,
        left: box.left,
        top: box.top,
        width: end.left - box.left,
        height: end.top - box.top,
        order,
        border: crop.top + crop.bottom + crop.left + crop.right > 0,
        focused: this.cursor.grid === layer.id,
        blend: layer.blend(),
      };
    });
    const key = JSON.stringify(frames, (k, v) => (k === 'win' ? undefined : v));
    if (key === this.floatsKey) return;
    this.floatsKey = key;
    this.onFloats?.(frames);
  }
}

/** z-index of a float's frame, just below its canvas. */
export function floatFrameZ(order: number): number {
  return Math.min(FLOAT_Z_MAX - 1, FLOAT_Z + 2 * order);
}
