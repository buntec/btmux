import type { Terminal } from 'ghostty-web';

export interface SearchRow {
  text: string;
  /** String index → cell column; null when every character is one cell wide. */
  cols: number[] | null;
}

export interface SearchMatch {
  /** Absolute buffer line (0 is the oldest scrollback line). */
  line: number;
  column: number;
  length: number;
}

const MAX_MATCHES = 5000;

/** Snapshot every buffer line (scrollback and screen) as searchable text. */
export function snapshotRows(term: Terminal): SearchRow[] {
  const buf = term.buffer.active;
  const rows: SearchRow[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    let text = '';
    let cols: number[] | null = [];
    let plain = true;
    for (let x = 0; line && x < line.length; x++) {
      const cell = line.getCell(x);
      // Width 0 is the spacer half of a wide character.
      if (!cell || cell.getWidth() === 0) {
        plain = false;
        continue;
      }
      const ch = cell.getChars() || ' ';
      if (ch.length !== 1 || cell.getWidth() !== 1) plain = false;
      text += ch;
      for (let i = 0; i < ch.length; i++) cols.push(x);
    }
    if (plain) cols = null;
    rows.push({ text: text.trimEnd(), cols });
  }
  return rows;
}

/**
 * Substring search, case-insensitive unless the query has an uppercase letter.
 * Matches do not span lines. Oldest first.
 */
export function findMatches(rows: SearchRow[], query: string): SearchMatch[] {
  if (!query) return [];
  const fold = query === query.toLowerCase();
  const out: SearchMatch[] = [];
  for (let line = 0; line < rows.length; line++) {
    const { text, cols } = rows[line];
    // Lowercasing can change a string's length; keep indices valid.
    const lowered = fold ? text.toLowerCase() : text;
    const hay = lowered.length === text.length ? lowered : text;
    for (let at = hay.indexOf(query); at !== -1; at = hay.indexOf(query, at + query.length)) {
      const start = cols ? cols[at] : at;
      const end = cols ? cols[at + query.length - 1] : at + query.length - 1;
      out.push({ line, column: start, length: end - start + 1 });
      if (out.length >= MAX_MATCHES) return out;
    }
  }
  return out;
}

/** `scrollToLine` argument that centers absolute buffer line `line`. */
export function viewportYFor(line: number, bufferLength: number, rows: number): number {
  return bufferLength - rows - line + Math.floor(rows / 2);
}
