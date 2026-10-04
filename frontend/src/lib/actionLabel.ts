const WORDS: Record<string, string> = { latex: 'LaTeX' };

/** Sentence-case label for a kebab-case keybinding action, e.g. `split-vertical` → `Split vertical`. */
export function actionLabel(action: string): string {
  const text = action
    .split('-')
    .map((word) => WORDS[word] ?? word)
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
