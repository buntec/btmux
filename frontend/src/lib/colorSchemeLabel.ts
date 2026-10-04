/** Short name for a color scheme given as a path or URL. */
export function colorSchemeLabel(value: string): string {
  return value.includes('/')
    ? value
        .replace(/\/+$/, '')
        .split('/')
        .pop()!
        .replace(/\.ya?ml$/i, '')
    : value;
}
