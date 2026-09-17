// Loaded on demand (see latexScan.ts) so KaTeX stays out of the main bundle.
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** Render TeX to HTML, or null if KaTeX rejects it. */
export function renderTex(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true, strict: false, trust: false });
  } catch {
    return null;
  }
}
