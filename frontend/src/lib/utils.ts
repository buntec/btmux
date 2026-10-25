import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
