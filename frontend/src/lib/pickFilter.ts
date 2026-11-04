/** What each item is filtered on: its label and description, lowercased. */
export function pickHaystack(item: { label: string; description: string | null }): string {
  const label = item.label.toLowerCase();
  return item.description ? `${label}\t${item.description.toLowerCase()}` : label;
}

/**
 * Items containing every whitespace-separated term, ignoring case, up to
 * `limit`: those whose label starts with the first term, then the rest, each
 * in input order. `total` counts every match.
 */
export function filterPick(haystacks: string[], query: string, limit: number): { indices: number[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const first: number[] = [];
  const rest: number[] = [];
  haystacks.forEach((haystack, index) => {
    if (!terms.every((term) => haystack.includes(term))) return;
    (terms.length && haystack.startsWith(terms[0]) ? first : rest).push(index);
  });
  return { indices: [...first, ...rest].slice(0, limit), total: first.length + rest.length };
}
