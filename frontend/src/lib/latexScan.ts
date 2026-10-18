import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaneTerminal } from './paneTerminal';
import { detectLatex, type LatexKind, type ScanLine } from './latexDetect';

export interface PaneLatexMatch {
  kind: LatexKind;
  tex: string;
  display: boolean;
  html: string;
  /** Source cells in absolute buffer coordinates. */
  cells: { line: number; column: number; length: number }[];
}

const DEBOUNCE_MS = 200;
// Streaming output never goes quiet; still rescan this often.
const MAX_WAIT_MS = 1000;
// Rows scanned beyond the viewport so a formula cut by its edge still matches.
const MARGIN_ROWS = 30;
const HTML_CACHE_MAX = 500;

type Render = (tex: string, display: boolean) => string | null;
let renderPromise: Promise<Render> | null = null;
const loadRender = () => (renderPromise ??= import('./katexRender').then((m) => m.renderTex));

const htmlCache = new Map<string, string | null>();

interface Row extends ScanLine {
  /** String index → cell column. */
  cols: number[];
}

function readRows(term: PaneTerminal): { rows: Row[]; first: number; top: number } {
  const top = term.viewportTop();
  const first = Math.max(0, top - MARGIN_ROWS);
  const last = Math.min(term.rowCount, top + term.rows + MARGIN_ROWS);
  const rows: Row[] = [];
  for (let y = first; y < last; y++) rows.push(term.readRow(y));
  // A row that wraps onto the next keeps its trailing spaces.
  rows.forEach((row, i) => {
    if (!rows[i + 1]?.wrapped) row.text = row.text.trimEnd();
  });
  return { rows, first, top };
}

/**
 * Scan a pane's emulator buffer for LaTeX. The pane calls `poke` after each
 * write; scroll and resize poke on their own.
 */
export function useLatexScan(term: PaneTerminal | null, enabled: boolean) {
  const [matches, setMatches] = useState<PaneLatexMatch[]>([]);
  const pokeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!term || !enabled) return;
    let disposed = false;
    let timer = 0;
    let firstPoke = 0;
    let lastText: string | null = null;
    let lastKey = '';

    const publish = (next: PaneLatexMatch[]) => {
      const key = JSON.stringify(next.map((m) => [m.tex, m.cells]));
      if (key === lastKey) return;
      lastKey = key;
      setMatches(next);
    };

    const run = async () => {
      const { rows, first, top } = readRows(term);
      const text = `${first}\n${rows.map((r) => (r.wrapped ? '\r' : '\n') + r.text).join('')}`;
      if (text === lastText) return;
      lastText = text;
      // Cheap pass first: KaTeX is only fetched once something looks like TeX.
      if (detectLatex(rows).length === 0) return publish([]);
      const render = await loadRender();
      if (disposed || text !== lastText) return;
      if (htmlCache.size > HTML_CACHE_MAX) htmlCache.clear();
      const html = (tex: string, display: boolean) => {
        const key = `${display ? 'd' : 'i'}${tex}`;
        if (!htmlCache.has(key)) htmlCache.set(key, render(tex, display));
        return htmlCache.get(key) ?? null;
      };
      const onScreen = (line: number) => line >= top && line < top + term.rows;
      const found = detectLatex(rows, {
        firstLine: first,
        validate: (tex, display) => html(tex, display) !== null,
      }).filter((m) => m.segments.some((s) => onScreen(s.line)));
      publish(
        found.map((m) => ({
          kind: m.kind,
          tex: m.tex,
          display: m.display,
          html: html(m.tex, m.display)!,
          cells: m.segments.map((s) => {
            const cols = rows[s.line - first].cols;
            return { line: s.line, column: cols[s.start], length: cols[s.end - 1] - cols[s.start] + 1 };
          }),
        })),
      );
    };

    const poke = () => {
      const now = performance.now();
      if (!timer) firstPoke = now;
      clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          timer = 0;
          void run();
        },
        Math.max(0, Math.min(DEBOUNCE_MS, firstPoke + MAX_WAIT_MS - now)),
      );
    };
    pokeRef.current = poke;
    const offScroll = term.onScroll(poke);
    const offResize = term.onResize(poke);
    poke();

    return () => {
      disposed = true;
      clearTimeout(timer);
      pokeRef.current = () => {};
      offScroll();
      offResize();
    };
  }, [term, enabled]);

  const poke = useCallback(() => pokeRef.current(), []);
  return { matches: enabled ? matches : [], poke };
}
