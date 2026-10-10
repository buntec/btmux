// Run with `just test-frontend` (bun test).
import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import type { NvimGrid as Grid } from './src/lib/nvimGrid';

// Bun has no DOM: a canvas whose 2D context records draw calls is enough for the grid.
type Call = [string, unknown[]];
interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  calls: Call[];
  getContext: () => unknown;
}

function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = { width: 300, height: 150, style: {}, calls: [], getContext: () => ctx };
  const state: Record<string | symbol, unknown> = {
    canvas,
    // 10×20 device-pixel cells.
    measureText: () => ({ width: 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 }),
  };
  const ctx = new Proxy(state, {
    get: (target, prop) =>
      prop in target ? target[prop] : (...args: unknown[]) => void canvas.calls.push([String(prop), args]),
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  return canvas;
}

let NvimGrid: typeof Grid;

beforeAll(async () => {
  Object.assign(globalThis, {
    document: { createElement: () => fakeCanvas() },
    window: { devicePixelRatio: 1 },
    requestAnimationFrame: () => 1,
  });
  ({ NvimGrid } = await import('./src/lib/nvimGrid'));
});

afterEach(() => {
  (performance.now as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const font = { family: 'monospace', size: 16, foreground: '#ffffff', background: '#000000' };

function makeGrid(cols = 8, rows = 5) {
  const canvas = fakeCanvas();
  const grid = new NvimGrid(canvas as unknown as HTMLCanvasElement, font);
  grid.resizeCanvas(cols * 10, rows * 20);
  grid.redraw([['grid_resize', [1, cols, rows]]]);
  return { grid, canvas };
}

const rowText = (grid: Grid, row: number) =>
  Array.from({ length: grid.cols }, (_, col) => grid.cell(row, col).text).join('');

/** Fill every row with a distinct letter: row 0 "aaaa…", row 1 "bbbb…", … */
function fillRows(grid: Grid) {
  grid.redraw([
    [
      'grid_line',
      ...Array.from({ length: grid.rows }, (_, row) => [1, row, 0, [[String.fromCharCode(97 + row), 0, grid.cols]], false]),
    ],
  ]);
}

test('measures cells and fits the grid to a CSS size', () => {
  const { grid } = makeGrid();
  expect([grid.cellWidth, grid.cellHeight]).toEqual([10, 20]);
  expect(grid.fit(805, 410)).toEqual([80, 20]);
  expect(grid.cellAt(35, 41)).toEqual([2, 3]);
  expect(grid.cellAt(-5, 9999)).toEqual([4, 0]); // clamped to the grid
});

test('grid_line applies repeats and carries the highlight forward', () => {
  const { grid } = makeGrid();
  grid.redraw([['grid_line', [1, 0, 1, [['a', 1], ['b'], ['c', 2, 3]], false]]]);
  expect(rowText(grid, 0)).toBe(' abccc  ');
  expect([1, 2, 3, 4, 5].map((col) => grid.cell(0, col).hl)).toEqual([1, 1, 2, 2, 2]);
});

test('wide characters occupy a cell plus an empty continuation cell', () => {
  const { grid } = makeGrid();
  grid.redraw([['grid_line', [1, 0, 0, [['漢', 0], [''], ['x']], false]]]);
  expect(grid.cell(0, 0).text).toBe('漢');
  expect(grid.cell(0, 1).text).toBe('');
  expect(grid.cell(0, 2).text).toBe('x');
});

test('grid_line past the edge is clipped', () => {
  const { grid } = makeGrid(4, 2);
  grid.redraw([['grid_line', [1, 0, 2, [['z', 0, 10]], false], [1, 9, 0, [['q', 0]], false]]]);
  expect(rowText(grid, 0)).toBe('  zz');
});

test('grid_scroll up moves rows within the region', () => {
  const { grid } = makeGrid(4, 5);
  fillRows(grid);
  grid.redraw([['grid_scroll', [1, 1, 4, 0, 4, 1, 0]]]);
  // Rows 1–2 take rows 2–3; row 3 keeps stale content until Neovim redraws it.
  expect([0, 1, 2, 3, 4].map((r) => rowText(grid, r))).toEqual(['aaaa', 'cccc', 'dddd', 'dddd', 'eeee']);
});

test('grid_scroll down moves rows the other way', () => {
  const { grid } = makeGrid(4, 5);
  fillRows(grid);
  grid.redraw([['grid_scroll', [1, 0, 5, 0, 4, -2, 0]]]);
  expect([0, 1, 2, 3, 4].map((r) => rowText(grid, r))).toEqual(['aaaa', 'bbbb', 'aaaa', 'bbbb', 'cccc']);
});

test('grid_scroll only touches the region columns', () => {
  const { grid } = makeGrid(4, 3);
  fillRows(grid);
  grid.redraw([['grid_scroll', [1, 0, 3, 1, 3, 1, 0]]]);
  expect([0, 1, 2].map((r) => rowText(grid, r))).toEqual(['abba', 'bccb', 'cccc']);
});

test('grid_resize keeps the overlapping content', () => {
  const { grid } = makeGrid(4, 3);
  fillRows(grid);
  grid.redraw([['grid_resize', [1, 2, 4]]]);
  expect([grid.cols, grid.rows]).toEqual([2, 4]);
  expect([0, 1, 2, 3].map((r) => rowText(grid, r))).toEqual(['aa', 'bb', 'cc', '  ']);
});

test('grid_clear blanks the grid', () => {
  const { grid } = makeGrid(4, 2);
  fillRows(grid);
  grid.redraw([['grid_clear', [1]]]);
  expect([rowText(grid, 0), rowText(grid, 1)]).toEqual(['    ', '    ']);
});

test('unknown events go to onEvent; flush calls onFlush', () => {
  const { grid } = makeGrid();
  const events: string[] = [];
  let flushes = 0;
  grid.onEvent = (name) => events.push(name);
  grid.onFlush = () => flushes++;
  grid.redraw([['cmdline_show', []], ['msg_show', [], []], ['flush', []]]);
  expect(events).toEqual(['cmdline_show', 'msg_show', 'msg_show']);
  expect(flushes).toBe(1);
});

test('default colors query Normal and fall back to the theme', () => {
  const { grid, canvas } = makeGrid(2, 1);
  let queried = 0;
  grid.onDefaultColors = () => queried++;
  grid.redraw([['default_colors_set', [0xaaaaaa, 0x000000, 0xff0000, 0, 0]], ['flush', []]]);
  expect(queried).toBe(1);
  expect(grid.attrStyle(0)).toEqual({});
  // Normal has a guifg but no guibg: Neovim's black is replaced by the btmux theme.
  grid.setNormal({ fg: 0xaaaaaa });
  canvas.calls = [];
  grid.redraw([['flush', []]]);
  grid.redraw([['hl_attr_define', [5, { foreground: 0x112233, reverse: true }, {}, []]]]);
  expect(grid.attrStyle(5)).toEqual({ color: '#000000', background: '#112233', bold: undefined, italic: undefined });
});

/** drawImage calls on the visible canvas since the last reset. */
const draws = (canvas: FakeCanvas) => canvas.calls.filter(([name]) => name === 'drawImage').map(([, args]) => args);

test('scrolls animate from the old position to the new one', () => {
  const now = spyOn(performance, 'now').mockReturnValue(1000);
  const { grid, canvas } = makeGrid(4, 5);
  grid.smoothScroll = 100;
  fillRows(grid);
  grid.redraw([['flush', []]]);
  canvas.calls = [];
  grid.redraw([['grid_scroll', [1, 0, 5, 0, 4, 1, 0]], ['flush', []]]);
  // Each frame: full grid, then per animation the old snapshot and the shifted region.
  // At t=0 the snapshot sits where it was and the new content one row (20px) lower.
  const [snapshot, region] = draws(canvas).slice(-2);
  expect(snapshot.length).toBe(3);
  expect(snapshot[2]).toBe(0);
  expect(region[6]).toBe(20); // 9-argument drawImage: dy is index 6

  now.mockReturnValue(1050);
  canvas.calls = [];
  grid.redraw([['flush', []]]);
  const mid = draws(canvas).at(-1)![6] as number;
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(20);

  now.mockReturnValue(1200);
  canvas.calls = [];
  grid.redraw([['flush', []]]);
  // Finished: only the plain grid blit remains.
  expect(draws(canvas).length).toBe(1);
});

test('scrolls in one batch accumulate; a scroll mid-animation continues from the offset', () => {
  const now = spyOn(performance, 'now').mockReturnValue(1000);
  const { grid, canvas } = makeGrid(4, 8);
  grid.smoothScroll = 100;
  fillRows(grid);
  grid.redraw([['flush', []]]);
  canvas.calls = [];
  grid.redraw([['grid_scroll', [1, 0, 8, 0, 4, 1, 0]], ['grid_scroll', [1, 0, 8, 0, 4, 1, 0]], ['flush', []]]);
  expect(draws(canvas).at(-1)![6]).toBe(40);

  now.mockReturnValue(1050);
  canvas.calls = [];
  grid.redraw([['grid_scroll', [1, 0, 8, 0, 4, 1, 0]], ['flush', []]]);
  const continued = draws(canvas).at(-1)![6] as number;
  // One more row (20px) on top of what was still left of the first animation.
  expect(continued).toBeGreaterThan(20);
  expect(continued).toBeLessThan(60);
});

test('scrolls taller than the region, or with animation off, are instant', () => {
  spyOn(performance, 'now').mockReturnValue(1000);
  const { grid, canvas } = makeGrid(4, 3);
  grid.smoothScroll = 100;
  fillRows(grid);
  grid.redraw([['flush', []]]);
  canvas.calls = [];
  grid.redraw([['grid_scroll', [1, 0, 3, 0, 4, 3, 0]], ['flush', []]]);
  expect(draws(canvas).length).toBe(1);

  grid.smoothScroll = 0;
  canvas.calls = [];
  grid.redraw([['grid_scroll', [1, 0, 3, 0, 4, 1, 0]], ['flush', []]]);
  expect(draws(canvas).length).toBe(1);
});
