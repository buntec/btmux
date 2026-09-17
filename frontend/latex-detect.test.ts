// Run with `just test-frontend` (bun test).
import { expect, test } from 'bun:test';
import katex from 'katex';
import { detectLatex, type ScanLine } from './src/lib/latexDetect';

const validate = (tex: string, displayMode: boolean) => {
  try {
    katex.renderToString(tex, { displayMode, throwOnError: true, strict: false });
    return true;
  } catch {
    return false;
  }
};

const lines = (s: string): ScanLine[] => s.split('\n').map((text) => ({ text, wrapped: false }));
const detect = (s: string) => detectLatex(lines(s), { validate });
const texs = (s: string) => detect(s).map((m) => m.tex);

test('explicit delimiters', () => {
  expect(texs('so $$E = mc^2$$ holds')).toEqual(['E = mc^2']);
  expect(texs('\\[\n  \\int_0^1 x\\,dx\n\\]')).toEqual(['\\int_0^1 x\\,dx']);
  expect(texs('inline \\(a+b\\) here')).toEqual(['a+b']);
  const env = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}';
  expect(texs(env)).toEqual([env]);
});

test('bare bracket block (Codex)', () => {
  const found = detect('The solution is\n\n[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n]\n\ndone');
  expect(found).toHaveLength(1);
  expect(found[0].kind).toBe('bare-bracket');
  expect(found[0].display).toBe(true);
  expect(found[0].segments.map((s) => s.line)).toEqual([2, 3, 4]);
});

test('bare bracket block inside a TUI gutter', () => {
  expect(texs('│ [            │\n│ \\sum_{i=1}^n i │\n│ ]            │')).toEqual(['\\sum_{i=1}^n i']);
});

test('inline dollars', () => {
  expect(texs('where $x_i$ and $\\alpha$ are given')).toEqual(['x_i', '\\alpha']);
});

test('bare parens need a command', () => {
  expect(texs('giving ( \\frac{a}{(b+c)} ) overall')).toEqual(['\\frac{a}{(b+c)}']);
  expect(texs('call f(x) and ( x^2 )')).toEqual([]);
});

test('shell and code noise', () => {
  for (const s of [
    'export PATH=$HOME/bin:$PATH',
    'echo $FOO_BAR and $BAZ_QUX',
    '$ ls -la',
    'kill -9 $$; echo $$',
    'costs $5 and then $10 more',
    "grep '\\[foo\\]' file",
    '[\n  "foo",\n  "bar"\n]',
    '[\n  { "snake_case": 1 }\n]',
    'match (\\bword\\b) in C:\\Users\\me',
    'arr[0] = (int) x;',
  ]) {
    expect(texs(s)).toEqual([]);
  }
});

test('soft-wrapped formula is rejoined', () => {
  const found = detectLatex(
    [
      { text: 'see $$a^2 + ', wrapped: false },
      { text: 'b^2 = c^2$$', wrapped: true },
    ],
    { validate, firstLine: 10 },
  );
  expect(found.map((m) => m.tex)).toEqual(['a^2 + b^2 = c^2']);
  expect(found[0].segments).toEqual([
    { line: 10, start: 4, end: 12 },
    { line: 11, start: 0, end: 11 },
  ]);
});

test('invalid TeX is dropped', () => {
  expect(texs('$$\\frac{a}{$$')).toEqual([]);
});
