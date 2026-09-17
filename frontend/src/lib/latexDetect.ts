/**
 * Heuristic LaTeX detection over terminal text. Pure: callers pass buffer lines
 * and get back candidate formulas with their source spans. Candidates still
 * need a real parse (KaTeX) before they are shown — see `validate`.
 */

export interface ScanLine {
  text: string;
  /** Soft-wrap continuation of the previous line. */
  wrapped: boolean;
}

export type LatexKind = 'dollars' | 'bracket' | 'env' | 'paren' | 'bare-bracket' | 'dollar' | 'bare-paren';

/** A span on one input line, in string indices (end exclusive). */
export interface LatexSegment {
  line: number;
  start: number;
  end: number;
}

export interface LatexMatch {
  kind: LatexKind;
  tex: string;
  display: boolean;
  /** Source span including delimiters, one entry per touched line. */
  segments: LatexSegment[];
}

export interface DetectOptions {
  /** Index of `lines[0]`, added to every reported segment line. */
  firstLine?: number;
  /** Final say on a candidate, e.g. a KaTeX parse. */
  validate?: (tex: string, display: boolean) => boolean;
}

const MAX_BODY_CHARS = 4000;
const MAX_BARE_BRACKET_LINES = 15;
const MAX_BARE_PAREN_CHARS = 300;

// TUI gutters and box borders that may frame agent output.
const GUTTER = '│┃▌▎▏•';
const LEAD = `[ \\t${GUTTER}]*`;
const TRAIL = '[ \\t│┃▕]*';

const COMMAND = /\\[a-zA-Z]{2,}/;
// x_i, x^2, )^2 — but not snake_case identifiers.
const SCRIPT = /(?:^|[^A-Za-z0-9_])[A-Za-z0-9][\^_][A-Za-z0-9{(\\]|[)}\]][\^_]/;

function strong(body: string): boolean {
  return COMMAND.test(body) || SCRIPT.test(body);
}

// Explicit delimiters earn a little more trust, but `kill $$; echo $$` and
// `grep '\[foo\]'` must still fail.
function weak(body: string): boolean {
  return strong(body) || /[=+<>≤≥]/.test(body);
}

function cleanBody(raw: string): string {
  const lead = new RegExp(`^${LEAD}`);
  const trail = new RegExp(`${TRAIL}$`);
  return raw
    .split('\n')
    .map((l) => l.replace(lead, '').replace(trail, ''))
    .join('\n')
    .trim();
}

interface Tier {
  kind: LatexKind;
  display: boolean;
  re: RegExp;
  /** Capture group holding the TeX body; 0 keeps the whole match. */
  group: number;
  accept: (body: string) => boolean;
}

const ENVS = 'equation|align|gather|alignat|flalign|multline|eqnarray|displaymath|math';

const TIERS: Tier[] = [
  { kind: 'dollars', display: true, re: /\$\$([\s\S]+?)\$\$/g, group: 1, accept: weak },
  { kind: 'bracket', display: true, re: /\\\[([\s\S]+?)\\\]/g, group: 1, accept: weak },
  {
    kind: 'env',
    display: true,
    re: new RegExp(`\\\\begin\\{(${ENVS})(\\*?)\\}[\\s\\S]+?\\\\end\\{\\1\\2\\}`, 'g'),
    group: 0,
    accept: () => true,
  },
  { kind: 'paren', display: false, re: /\\\(([\s\S]+?)\\\)/g, group: 1, accept: weak },
  {
    // `\[ … \]` after a markdown renderer ate the backslashes (Codex et al.).
    kind: 'bare-bracket',
    display: true,
    re: new RegExp(`^${LEAD}\\[${TRAIL}\\n([\\s\\S]*?)\\n${LEAD}\\]${TRAIL}$`, 'gm'),
    group: 1,
    accept: (body) => body.split('\n').length <= MAX_BARE_BRACKET_LINES && strong(body),
  },
  {
    // No space just inside the delimiters and no identifier right after, so
    // `$HOME/bin:$PATH` and `$ ls` prompts never pair up.
    kind: 'dollar',
    display: false,
    re: /(?<![\\$A-Za-z0-9])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![A-Za-z0-9$])/g,
    group: 1,
    accept: strong,
  },
];

/** Outermost balanced `( … )` groups on one logical line that hold a command. */
function bareParens(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '(' || text[i - 1] === '\\') {
      i++;
      continue;
    }
    let depth = 0;
    let end = -1;
    const limit = Math.min(text.length, i + MAX_BARE_PAREN_CHARS);
    for (let j = i; j < limit; j++) {
      const ch = text[j];
      if (ch === '\n') break;
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end < 0) {
      i++;
      continue;
    }
    if (COMMAND.test(text.slice(i + 1, end - 1))) {
      out.push({ start: i, end });
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

export function detectLatex(lines: ScanLine[], opts: DetectOptions = {}): LatexMatch[] {
  const firstLine = opts.firstLine ?? 0;
  const validate = opts.validate ?? (() => true);

  // Join soft-wrapped rows into logical lines, remembering where each row starts.
  let text = '';
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (i > 0 && !line.wrapped) text += '\n';
    starts.push(text.length);
    text += line.text;
  });

  const segmentsFor = (start: number, end: number): LatexSegment[] => {
    const segs: LatexSegment[] = [];
    for (let i = 0; i < lines.length; i++) {
      const s = Math.max(start, starts[i]);
      const e = Math.min(end, starts[i] + lines[i].text.length);
      if (s < e) segs.push({ line: firstLine + i, start: s - starts[i], end: e - starts[i] });
    }
    return segs;
  };

  const taken: { start: number; end: number; match: LatexMatch }[] = [];
  const overlaps = (start: number, end: number) => taken.some((t) => start < t.end && t.start < end);
  const consider = (tier: Pick<Tier, 'kind' | 'display'>, start: number, end: number, raw: string): boolean => {
    if (raw.length > MAX_BODY_CHARS || overlaps(start, end)) return false;
    const tex = cleanBody(raw);
    if (!tex || !validate(tex, tier.display)) return false;
    taken.push({
      start,
      end,
      match: { kind: tier.kind, tex, display: tier.display, segments: segmentsFor(start, end) },
    });
    return true;
  };

  for (const tier of TIERS) {
    tier.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tier.re.exec(text))) {
      const body = m[tier.group];
      const ok = tier.accept(body) && consider(tier, m.index, m.index + m[0].length, body);
      // A rejected match may hide a real one that starts inside it.
      if (!ok) tier.re.lastIndex = m.index + 1;
    }
  }

  // `\( … \)` with the backslashes eaten. Lowest confidence, so it runs last.
  for (const { start, end } of bareParens(text)) {
    consider({ kind: 'bare-paren', display: false }, start, end, text.slice(start + 1, end - 1));
  }

  return taken.sort((a, b) => a.start - b.start).map((t) => t.match);
}
