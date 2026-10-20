export interface UrlMatch {
  url: string;
  /** String indices, end exclusive. */
  start: number;
  end: number;
}

// Box drawing and block elements often border URLs in TUIs.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`─-▟]+/gi;
const TRAILING = /[.,;:!?*]$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Drop trailing punctuation and unbalanced closing brackets. */
function trimUrl(url: string) {
  for (;;) {
    const last = url[url.length - 1];
    const opener = CLOSERS[last];
    if (TRAILING.test(url) || (opener && count(url, last) > count(url, opener))) url = url.slice(0, -1);
    else return url;
  }
}

/** HTTP(S) URLs in plain text. */
export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    try {
      if (!new URL(url).host) continue;
    } catch {
      continue;
    }
    matches.push({ url, start: m.index, end: m.index + url.length });
  }
  return matches;
}
