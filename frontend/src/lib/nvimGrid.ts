// Neovim `ext_linegrid` model and Canvas2D renderer.

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
}

interface ModeInfo {
  cursor_shape?: 'block' | 'horizontal' | 'vertical';
  cell_percentage?: number;
  attr_id?: number;
}

export interface GridFont {
  family: string;
  size: number;
  /** Extra CSS pixels between rows ('linespace'). */
  linespace?: number;
  /** Fallback colors until Neovim sends `default_colors_set`. */
  foreground: string;
  background: string;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

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

export class NvimGrid {
  cols = 0;
  rows = 0;
  private text: string[] = [];
  private hlIds: Uint32Array = new Uint32Array(0);
  private hl = new Map<number, HlAttr>();
  private fg: string;
  private bg: string;
  private sp: string;
  private cursorRow = 0;
  private cursorCol = 0;
  private modes: ModeInfo[] = [];
  private mode = 0;
  private busy = false;
  private dirty = new Set<number>();
  private nvimDefaults = { fg: -1, bg: -1, sp: -1 };
  // Fields of the Normal group; unset ones fall back to the btmux theme, like a TUI.
  private normal = { fg: false, bg: false, sp: false };
  /** Called when Neovim's default colors change, to re-query Normal. */
  onDefaultColors: (() => void) | null = null;
  /** Receives events the grid doesn't handle (cmdline, popupmenu, …). */
  onEvent: ((name: string, args: unknown[]) => void) | null = null;
  /** Called after each `flush` is drawn. */
  onFlush: (() => void) | null = null;
  /** Hide the grid cursor, e.g. while an external cmdline owns it. */
  cursorHidden = false;
  /** Scroll animation length in ms; 0 scrolls instantly. */
  smoothScroll = 0;
  // Visible canvas, composed each frame from the offscreen grid plus scroll animations and the cursor.
  private ctx: CanvasRenderingContext2D;
  private gridCanvas = document.createElement('canvas');
  private gctx: CanvasRenderingContext2D;
  private anims = new Map<string, ScrollAnim>();
  // Regions already snapshotted in the current redraw batch.
  private scrolledThisBatch = new Set<string>();
  private frame = 0;

  cellWidth = 1;
  cellHeight = 1;
  private ascent = 1;
  private dpr = 1;
  private font: GridFont;

  constructor(
    private canvas: HTMLCanvasElement,
    font: GridFont,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.gctx = this.gridCanvas.getContext('2d', { alpha: false })!;
    this.font = font;
    this.fg = font.foreground;
    this.bg = font.background;
    this.sp = font.foreground;
    this.measure();
  }

  setFont(font: GridFont) {
    this.font = font;
    this.measure();
    this.anims.clear();
    this.updateDefaults();
    this.flush();
  }

  /** Device-pixel cell metrics for the current font and DPR. */
  measure() {
    this.dpr = window.devicePixelRatio || 1;
    this.gctx.font = this.fontString(false, false);
    const m = this.gctx.measureText('M');
    this.cellWidth = m.width;
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
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gridCanvas.width = this.canvas.width;
    this.gridCanvas.height = this.canvas.height;
    this.anims.clear();
    this.redrawAll();
    this.flush();
  }

  /** Cell under a CSS-pixel offset within the canvas. */
  cellAt(x: number, y: number): [number, number] {
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((y * this.dpr) / this.cellHeight)));
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((x * this.dpr) / this.cellWidth)));
    return [row, col];
  }

  /** CSS-pixel box of the cursor cell. */
  cursorRect(): { left: number; top: number; height: number } {
    return this.cellRect(this.cursorRow, this.cursorCol);
  }

  /** Text and highlight id of a cell ("" for the right half of a wide character). */
  cell(row: number, col: number): { text: string; hl: number } {
    const i = row * this.cols + col;
    return { text: this.text[i], hl: this.hlIds[i] };
  }

  /** CSS-pixel box of a cell, for anchoring external widgets. */
  cellRect(row: number, col: number): { left: number; top: number; height: number } {
    return {
      left: (col * this.cellWidth) / this.dpr,
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

  private apply(name: string, args: unknown[]) {
    switch (name) {
      case 'grid_resize': {
        const [, cols, rows] = args as number[];
        this.resizeGrid(cols, rows);
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
      case 'grid_line': {
        const [, row, colStart, cells] = args as [number, number, number, [string, number?, number?][]];
        if (row >= this.rows) break;
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
        break;
      }
      case 'grid_clear':
        this.anims.clear();
        this.text.fill(' ');
        this.hlIds.fill(0);
        this.redrawAll();
        break;
      case 'grid_cursor_goto': {
        const [, row, col] = args as number[];
        this.cursorRow = row;
        this.cursorCol = col;
        break;
      }
      case 'grid_scroll': {
        const [, top, bot, left, right, rows] = args as number[];
        this.beginScrollAnim(top, bot, left, right, rows);
        this.scroll(top, bot, left, right, rows);
        break;
      }
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

  private resizeGrid(cols: number, rows: number) {
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
    this.redrawAll();
  }

  private scroll(top: number, bot: number, left: number, right: number, rows: number) {
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
    for (let r = 0; r < this.rows; r++) this.dirty.add(r);
  }

  private fontString(bold: boolean, italic: boolean) {
    return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${this.font.size * this.dpr}px ${this.font.family}`;
  }

  private colors(hlId: number): { fg: string; bg: string; sp: string; attr: HlAttr } {
    const attr = this.hl.get(hlId) ?? {};
    let fg = attr.foreground !== undefined ? hex(attr.foreground) : this.fg;
    let bg = attr.background !== undefined ? hex(attr.background) : this.bg;
    if (attr.reverse) [fg, bg] = [bg, fg];
    const sp = attr.special !== undefined ? hex(attr.special) : this.sp;
    return { fg, bg, sp, attr };
  }

  private flush() {
    const ctx = this.gctx;
    // Fill the margin outside the grid.
    ctx.fillStyle = this.bg;
    const gridW = Math.round(this.cols * this.cellWidth);
    const gridH = this.rows * this.cellHeight;
    ctx.fillRect(gridW, 0, this.canvas.width - gridW, this.canvas.height);
    ctx.fillRect(0, gridH, this.canvas.width, this.canvas.height - gridH);
    for (const row of this.dirty) if (row < this.rows) this.drawRow(row);
    this.dirty.clear();
    this.scrolledThisBatch.clear();
    this.present();
  }

  /** Remaining pixel offset of a scroll animation (ease-out cubic). */
  private animOffset(anim: ScrollAnim, now: number): number {
    const t = this.smoothScroll > 0 ? Math.min(1, (now - anim.start) / this.smoothScroll) : 1;
    return Math.round(anim.from * (1 - t) ** 3);
  }

  /** Snapshot a region before Neovim scrolls it, so the move can be animated. */
  private beginScrollAnim(top: number, bot: number, left: number, right: number, rows: number) {
    if (this.smoothScroll <= 0) return;
    const key = `${top}:${bot}:${left}:${right}`;
    const height = (bot - top) * this.cellHeight;
    const delta = rows * this.cellHeight;
    const existing = this.anims.get(key);
    // A second scroll before the flush: the displayed pixels haven't changed.
    if (existing && this.scrolledThisBatch.has(key)) {
      existing.from += delta;
      if (Math.abs(existing.from) >= height) this.anims.delete(key);
      return;
    }
    const now = performance.now();
    const residual = existing ? this.animOffset(existing, now) : 0;
    const from = delta + residual;
    if (Math.abs(from) >= height) {
      this.anims.delete(key);
      return;
    }
    // Capture what is on screen now, without the cursor.
    this.compose(now, false);
    const x0 = Math.round(left * this.cellWidth);
    const width = Math.round(right * this.cellWidth) - x0;
    const snapshot = existing?.snapshot ?? document.createElement('canvas');
    snapshot.width = width;
    snapshot.height = height;
    snapshot.getContext('2d')!.drawImage(this.canvas, x0, top * this.cellHeight, width, height, 0, 0, width, height);
    this.anims.set(key, { top, bot, left, right, snapshot, from, start: now });
    this.scrolledThisBatch.add(key);
  }

  /** Draw the current frame, and keep animating while scrolls are in flight. */
  private present() {
    this.compose(performance.now(), true);
    if (this.anims.size && !this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.present();
      });
    }
  }

  private compose(now: number, withCursor: boolean) {
    const ctx = this.ctx;
    ctx.drawImage(this.gridCanvas, 0, 0);
    let cursorOffset = 0;
    for (const [key, anim] of this.anims) {
      const d = this.animOffset(anim, now);
      // Finished: the plain grid blit above already shows the final position.
      if (d === 0 && !this.scrolledThisBatch.has(key)) {
        this.anims.delete(key);
        continue;
      }
      const x0 = Math.round(anim.left * this.cellWidth);
      const width = Math.round(anim.right * this.cellWidth) - x0;
      const y0 = anim.top * this.cellHeight;
      const height = (anim.bot - anim.top) * this.cellHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, width, height);
      ctx.clip();
      ctx.fillStyle = this.bg;
      ctx.fillRect(x0, y0, width, height);
      ctx.drawImage(anim.snapshot, x0, y0 + d - anim.from);
      ctx.drawImage(this.gridCanvas, x0, y0, width, height, x0, y0 + d, width, height);
      ctx.restore();
      const { cursorRow: r, cursorCol: c } = this;
      if (r >= anim.top && r < anim.bot && c >= anim.left && c < anim.right) cursorOffset = d;
    }
    if (withCursor) this.drawCursor(cursorOffset);
  }

  private drawRow(row: number) {
    const ctx = this.gctx;
    const y = row * this.cellHeight;
    const base = row * this.cols;
    // Clip so glyphs that overflow their cell can't leave residue in neighboring rows.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, this.canvas.width, this.cellHeight);
    ctx.clip();
    // Backgrounds, in runs of equal highlight.
    let start = 0;
    while (start < this.cols) {
      const id = this.hlIds[base + start];
      let end = start + 1;
      while (end < this.cols && this.hlIds[base + end] === id) end++;
      ctx.fillStyle = this.colors(id).bg;
      const x0 = Math.round(start * this.cellWidth);
      ctx.fillRect(x0, y, Math.round(end * this.cellWidth) - x0, this.cellHeight);
      start = end;
    }
    // Glyphs and decorations, per cell to keep grid alignment.
    ctx.textBaseline = 'alphabetic';
    for (let col = 0; col < this.cols; col++) {
      const text = this.text[base + col];
      if (!text || text === ' ') {
        const attr = this.hl.get(this.hlIds[base + col]);
        if (!attr || !(attr.underline || attr.undercurl || attr.strikethrough)) continue;
      }
      const { fg, sp, attr } = this.colors(this.hlIds[base + col]);
      this.drawGlyph(ctx, text, col, row, fg, attr);
      this.drawDecorations(col, row, fg, sp, attr);
    }
    ctx.restore();
  }

  private drawGlyph(
    ctx: CanvasRenderingContext2D,
    text: string,
    col: number,
    row: number,
    fg: string,
    attr: HlAttr,
    yOffset = 0,
  ) {
    if (!text || text === ' ') return;
    ctx.font = this.fontString(!!attr.bold, !!attr.italic);
    ctx.fillStyle = fg;
    ctx.fillText(text, Math.round(col * this.cellWidth), row * this.cellHeight + this.ascent + yOffset);
  }

  private drawDecorations(col: number, row: number, fg: string, sp: string, attr: HlAttr) {
    const ctx = this.gctx;
    const x = Math.round(col * this.cellWidth);
    const w = Math.round((col + 1) * this.cellWidth) - x;
    const y = row * this.cellHeight;
    const thickness = Math.max(1, Math.round(this.dpr));
    if (attr.strikethrough) {
      ctx.fillStyle = fg;
      ctx.fillRect(x, y + Math.round(this.cellHeight / 2), w, thickness);
    }
    const underY = y + this.cellHeight - 2 * thickness;
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
    } else if (attr.underline || attr.underdouble || attr.underdotted || attr.underdashed) {
      ctx.fillStyle = sp;
      ctx.fillRect(x, underY, w, thickness);
      if (attr.underdouble) ctx.fillRect(x, underY - 2 * thickness, w, thickness);
    }
  }

  private drawCursor(yOffset: number) {
    if (this.busy || this.cursorHidden || this.cursorRow >= this.rows || this.cursorCol >= this.cols) return;
    const info = this.modes[this.mode] ?? {};
    const idx = this.cursorRow * this.cols + this.cursorCol;
    const cell = this.colors(this.hlIds[idx]);
    const cursorAttr = info.attr_id ? this.hl.get(info.attr_id) : undefined;
    // attr_id 0 means "invert the cell".
    const cursorBg = cursorAttr?.background !== undefined ? hex(cursorAttr.background) : cell.fg;
    const cursorFg = cursorAttr?.foreground !== undefined ? hex(cursorAttr.foreground) : cell.bg;
    const x = Math.round(this.cursorCol * this.cellWidth);
    const wide = this.cursorCol + 1 < this.cols && this.text[idx + 1] === '';
    const w = Math.round((this.cursorCol + (wide ? 2 : 1)) * this.cellWidth) - x;
    const y = this.cursorRow * this.cellHeight + yOffset;
    const pct = (info.cell_percentage ?? 100) / 100;
    const ctx = this.ctx;
    ctx.fillStyle = cursorBg;
    switch (info.cursor_shape) {
      case 'vertical':
        ctx.fillRect(x, y, Math.max(this.dpr, Math.round(w * pct)), this.cellHeight);
        break;
      case 'horizontal': {
        const h = Math.max(this.dpr, Math.round(this.cellHeight * pct));
        ctx.fillRect(x, y + this.cellHeight - h, w, h);
        break;
      }
      default:
        ctx.fillRect(x, y, w, this.cellHeight);
        this.drawGlyph(ctx, this.text[idx], this.cursorCol, this.cursorRow, cursorFg, cell.attr, yOffset);
    }
  }
}
