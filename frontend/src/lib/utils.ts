/** The root of an absolute path: `/`, or a Windows drive such as `C:/`. */
export function pathRoot(path: string): string {
  return /^[A-Za-z]:\//.exec(path)?.[0] ?? '/';
}

export function getParent(path: string): string {
  const root = pathRoot(path);
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash < root.length) return root;
  return path.slice(0, lastSlash);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Moves a list cursor by `delta`, clamped; with `wrap`, a step past an end it's on wraps to the other. */
export function stepIndex(index: number, delta: number, count: number, wrap: boolean): number {
  if (count <= 0) return 0;
  if (wrap && delta > 0 && index >= count - 1) return 0;
  if (wrap && delta < 0 && index <= 0) return count - 1;
  return Math.max(0, Math.min(index + delta, count - 1));
}

/** The focused row, or the row now at its position if it's gone or `keepPosition`. */
export function resolveFocusedRow<T>(
  rows: T[],
  isFocused: (row: T) => boolean,
  previousIndex: number,
  keepPosition = false,
): T | null {
  if (rows.length === 0) return null;
  return (!keepPosition && rows.find(isFocused)) || rows[Math.max(0, Math.min(previousIndex, rows.length - 1))];
}
