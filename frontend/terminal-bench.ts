/**
 * Terminal rendering and throughput benchmark. Run with
 * `bun browser-test-stack.ts terminal-bench.ts`; prints one JSON line.
 * BENCH_HEADED=1 runs a visible browser; keep its window in front, or macOS
 * throttles its animation frames.
 */
import { chromium, type Page } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.env.BTMUX_TEST_URL!;
const token = process.env.BTMUX_AUTH_TOKEN!;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (p: string, body?: unknown) => {
  const r = await fetch(`${url}${p}`, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
};

/** Every pane has finished its initial replay. */
const isAttached = () =>
  document.querySelector('[data-pane-id]') &&
  ![...document.querySelectorAll('[data-pane-id] [role=status]')].some((e) => /Connecting|Reconnecting/.test(e.textContent ?? ''));

const dir = mkdtempSync(path.join(tmpdir(), 'btmux-bench-'));
const frames = path.join(dir, 'frames.py');
// A TUI-like redraw: alternate screen, color runs of 8 cells, full screen per frame.
writeFileSync(
  frames,
  `import sys, time
cols, rows, n, fps = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
w = sys.stdout.write
w('\\x1b[?1049h\\x1b[?25l')
for i in range(n):
    out = ['\\x1b[H']
    for r in range(rows):
        line = []
        for c in range(0, cols, 8):
            line.append('\\x1b[38;5;%dm\\x1b[48;5;%dm' % ((r * 7 + c + i) % 256, (r + c // 8 + i) % 24 + 232))
            line.append(''.join(chr(65 + (c + k + i + r) % 26) for k in range(min(8, cols - c))))
        out.append(''.join(line) + '\\x1b[0m' + ('\\r\\n' if r < rows - 1 else ''))
    w(''.join(out)); sys.stdout.flush()
    if fps: time.sleep(1 / fps)
w('\\x1b[?25h\\x1b[?1049l')
`,
);

const session = await api('/api/sessions', { name: 'bench' });
const snapshot = await api(`/api/sessions/${session.id}`);
const pane = snapshot.windows[0].panes[0].id;
const browser = await chromium.launch({
  headless: !process.env.BENCH_HEADED,
  channel: 'chromium',
  args: [
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.getByLabel('Access token').fill(token);
await page.getByRole('button', { name: 'Connect', exact: true }).click();
await page.waitForFunction(() => !document.querySelector('#access-token'));
await page.goto(`${url}/s/bench`);
await page.waitForFunction(isAttached);
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'none';
});

/** Last rows of the pane's emulator. */
const tail = (p: Page, id: string) =>
  p.evaluate(async (id) => {
    const { useStore } = await import('/src/state/store.tsx' as string);
    const t = useStore.getState().terminals.get(id);
    if (!t) return '';
    const out = [];
    for (let y = Math.max(0, t.rowCount - 60); y < t.rowCount; y++) out.push(t.readRow(y).text);
    return out.join('\n');
  }, id);

const metrics = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m: { name: string; value: number }) => [m.name, m.value]));
};

const startFrames = (p: Page) =>
  p.evaluate(() => {
    const w = window as any;
    w.benchFrames = [];
    w.benchRun = true;
    const tick = (t: number) => {
      w.benchFrames.push(t);
      if (w.benchRun) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopFrames = (p: Page) =>
  p.evaluate(() => {
    const w = window as any;
    w.benchRun = false;
    const f: number[] = w.benchFrames;
    const gaps = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
    const pct = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
    return { frames: f.length, p50: pct(0.5), p95: pct(0.95), max: gaps[gaps.length - 1] ?? 0, over50: gaps.filter((g) => g > 50).length };
  });

const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));

/** Run a shell command in the pane until it prints DONE_MARK; report wall time and main-thread cost. */
let run = 0;
async function workload(name: string, command: string, id = pane) {
  const mark = `DONE_${++run}_MARK`;
  await page.waitForTimeout(500);
  const before = await metrics();
  await startFrames(page);
  const t0 = Date.now();
  await api(`/api/panes/${id}/input`, { text: `${command}; echo DONE_${run}""_MARK\r` });
  while (!(await tail(page, id)).includes(mark)) {
    if (Date.now() - t0 > 180_000) throw new Error(`${name} timed out`);
    await page.waitForTimeout(20);
  }
  const wall = Date.now() - t0;
  await page.waitForTimeout(300);
  const frame = await stopFrames(page);
  const after = await metrics();
  const ms = (k: string) => (after[k] - before[k]) * 1000;
  return {
    name,
    ...round({
      wallMs: wall,
      taskMs: ms('TaskDuration'),
      scriptMs: ms('ScriptDuration'),
      layoutMs: ms('LayoutDuration'),
      styleMs: ms('RecalcStyleDuration'),
      ...frame,
    }),
  };
}

const size = await page.evaluate(async (id) => {
  const { useStore } = await import('/src/state/store.tsx' as string);
  const t = useStore.getState().terminals.get(id);
  return [t.cols, t.rows];
}, pane);
const results: unknown[] = [];

// Idle frame rate, to validate the harness.
await startFrames(page);
await page.waitForTimeout(1000);
results.push({ name: 'idle-raf', ...round(await stopFrames(page)) });

/** Write one full-screen colored frame per animation frame straight into the emulator. */
async function renderLoop(name: string, count: number, run = 8, id = pane) {
  await page.waitForTimeout(500);
  const before = await metrics();
  const t0 = Date.now();
  const frame = await page.evaluate(
    async ({ id, count, run }) => {
      const { useStore } = await import('/src/state/store.tsx' as string);
      const t = useStore.getState().terminals.get(id);
      const { cols, rows } = t;
      const enc = new TextEncoder();
      const frames: Uint8Array[] = [];
      for (let i = 0; i < 16; i++) {
        let out = '\x1b[H';
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c += run) {
            out +=
              run === 8
                ? `\x1b[38;5;${(r * 7 + c + i) % 256}m\x1b[48;5;${((r + c / 8 + i) % 24) + 232}m`
                : `\x1b[3${((r + c / run + i) % 6) + 1}m`;
            for (let k = 0; k < Math.min(run, cols - c); k++)
              out += k % 6 === 5 ? ' ' : String.fromCharCode(97 + ((c + k + i + r) % 26));
          }
          out += '\x1b[0m' + (r < rows - 1 ? '\r\n' : '');
        }
        frames.push(enc.encode(out));
      }
      t.write('\x1b[?1049h');
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let i = 0;
        const tick = (now: number) => {
          times.push(now);
          if (i === count) return resolve();
          t.write(frames[i++ % frames.length]);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      t.write('\x1b[?1049l');
      const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
      const pct = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
      return { fps: (1000 * gaps.length) / (times[times.length - 1] - times[0]), p50: pct(0.5), p95: pct(0.95), max: gaps[gaps.length - 1] };
    },
    { id, count, run },
  );
  const after = await metrics();
  const ms = (k: string) => (after[k] - before[k]) * 1000;
  return {
    name,
    ...round({
      wallMs: Date.now() - t0,
      taskMsPerFrame: ms('TaskDuration') / count,
      scriptMsPerFrame: ms('ScriptDuration') / count,
      layoutStyleMsPerFrame: (ms('LayoutDuration') + ms('RecalcStyleDuration')) / count,
      ...frame,
    }),
  };
}
results.push(await renderLoop('render-heavy-600', 600));
results.push(await renderLoop('render-text-600', 600, 24));
results.push(await workload('seq-200k', 'seq 1 200000'));
results.push(await workload('cat-8MiB', `head -c 6000000 /dev/urandom | base64 | fold -w 100`));
results.push(await workload('tui-burst-300', `python3 ${frames} ${size[0]} ${size[1]} 300 0`));

// Reconnect replay: a fresh tab attaching to a pane with a full journal.
const replay: number[] = [];
for (let i = 0; i < 3; i++) {
  const p = await context.newPage();
  const t0 = Date.now();
  await p.goto(`${url}/s/bench`);
  await p.waitForFunction(isAttached, null, {
    timeout: 120_000,
  });
  replay.push(Date.now() - t0);
  await p.close();
}
results.push({ name: 'fresh-tab-replay', runs: replay });

// Four panes with scrollback: memory and DOM size.
for (const direction of ['vertical', 'horizontal', 'horizontal']) {
  await api(`/api/sessions/${session.id}/panes/${pane}/split`, { direction });
}
await page.waitForTimeout(3000);
const panes = (await api(`/api/sessions/${session.id}`)).windows[0].panes.map((p: { id: string }) => p.id);
for (const id of panes.filter((id: string) => id !== pane)) await workload('fill', 'seq 1 20000', id);
await page.evaluate(() => (window as any).gc?.());
await cdp.send('HeapProfiler.collectGarbage');
const m = await metrics();
results.push({
  name: 'four-panes',
  heapMB: Math.round(m.JSHeapUsedSize / 1e5) / 10,
  domNodes: m.Nodes,
});
results.push(await renderLoop('render-heavy-600-4panes', 600));
results.push(await renderLoop('render-text-600-4panes', 600, 24));

console.log(JSON.stringify({ gpu, size, results, errors }));
await browser.close();
await fetch(`${url}/api/sessions/${session.id}`, { method: 'DELETE', headers });
